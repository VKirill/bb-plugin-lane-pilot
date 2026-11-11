# Сквозная аналитика в BigQuery, Looker Studio и Power BI: SQL-витрины, защита от дублей Data Blending и сверка расхождений

> **Целевой скилл**: `mkt-end-to-end-analytics`
> **Назначение**: Инженерная спецификация хранения и объединения сырых данных рекламных кабинетов, веб-аналитики (GA4 / Яндекс Метрика Logs API) и CRM / продуктовой БД в Google BigQuery / ClickHouse / PostgreSQL, правила моделирования витрин под Looker Studio (плоская таблица единого зерна) и Power BI (схема «Звезда») и регламент автоматической сверки расхождений (`funnel_reconcile.py`).

---

## 1. Ключи связки и нормализация рекламных расходов (`ETL / ELT`)

Сквозная витрина соединяет три независимых слоя данных, у каждого из которых собственное первичное зерно и собственные системные искажения:

$$\underbrace{\text{Рекламные кабинеты}}_{\text{Зерно: } (\text{Date}, \text{UTM / AdId})} \xleftrightarrow{\text{Date + UTM / ClickID}} \underbrace{\text{Веб-/Бот-аналитика}}_{\text{Зерно: } (\text{SessionId}, \text{ClientId})} \xleftrightarrow{\text{ClientId / UserId / StartParam}} \underbrace{\text{CRM / Платёжная БД}}_{\text{Зерно: } (\text{LeadId / DealId / OrderId})}$$

### 1.1. Обязательные правила нормализации выгрузок рекламных расходов
1. **Деление микро-валюты Яндекс Директа (`Cost / 1 000 000`)**: в сырых отчётах API Директа (`Reports` TSV без флага `returnMoneyInMicros: false`) денежные поля возвращаются умноженными на `10^6`. На этапе загрузки в DWH применяется явное приведение `SAFE_DIVIDE(cost_micros, 1000000.0)`.
2. **Единый стандарт НДС (`IncludeVAT`) и курсов валют**:
   - Нельзя складывать в одной колонке `Spend` расход Яндекс Директа без НДС (`IncludeVAT: NO`), расход VK Рекламы с НДС 20% и расход Telegram Ads в `TON` или `EUR` (с комиссией реселлера 15–20%).
   - В DWH хранятся три прозрачных поля: `spend_raw_currency`, `currency_code`, `spend_net_base` (без НДС) и `spend_gross_base` (полный фактический списанный кэшфлоу с учётом НДС и агентской комиссии по курсу даты открутки). Все формулы `CAC`, `CPL`, `CPS`, `ROMI` и `ROAS` считаются по **полному фактическому денежному расходу (`spend_gross_base`)**.
3. **Окно ретроспективной перезаписи расходов (`Overwrite Window = 7–30 дней`)**:
   - Антифрод Яндекс Директа и рекламных сетей возвращает деньги за отфильтрованные недействительные клики спустя `1–5` суток после показа, а сессии Яндекс Метрики финализируются до `3` суток.
   - Ежедневный ETL-пайплайн обязан не просто дописывать `yesterday()`, а идемпотентно **перезаписывать партиции за скользящие последние `7–14` дней** (раз в месяц — контрольная сверка за `30` дней).
4. **Единственная шина на источник**: при использовании коннекторов или вебхуков создаётся один канонический маршрут приёма события в хранилище с последующим разветвлением приёмников, чтобы исключить двойную запись сделок и выжигание суточных лимитов API (например, `5 000` запросов/сутки и `10 ГБ` нечищеных логов в Яндекс Метрике, где после скачивания частей Logs API обязателен вызов `POST .../clean`).

---

## 2. Google BigQuery: SQL-паттерны для GA4 (`events_*`) и контроль стоимости

В отличие от стандартного интерфейса GA4 (подверженного порогам конфиденциальности `thresholding`, ограничениям кардинальности `(other)` и запрету хранения PII), бесплатный нативный экспорт `GA4 -> BigQuery` (`events_YYYYMMDD` + стриминг `events_intraday_YYYYMMDD`) даёт несемплированные сырые события.

### 2.1. Пять правил защиты бюджета в BigQuery (`On-Demand $5 / ТБ`)
1. **Полный запрет `SELECT *`**: колоночное хранилище тарифицирует объём прочитанных байт только в явно перечисленных столбцах; добавление `LIMIT 10` **не уменьшает** объём сканирования и стоимость запроса.
2. **Фильтрация шардов через `_TABLE_SUFFIX`** на шаблонных таблицах `events_*` и **партиционирование по `DATE` + кластеризация** (`CLUSTER BY utm_source, utm_medium, event_name`) на всех собственных витринах CRM и рекламных расходов.
3. **Предварительный `--dry_run`** в автоматических скриптах с жёстким лимитом `maximumBytesBilled` (защитный предохранитель от случайного скана многолетнего архива).
4. **Материализация промежуточных слоёв**: BI-дашборды (Looker Studio / Power BI / DataLens) никогда не ходят прямыми живыми запросами в сырые вложенные таблицы `events_*` на каждый клик фильтра — они читают предрассчитанную суточную партиционированную таблицу `mart_marketing_daily`.
5. **Разделение контуров PII**: телефоны и email из CRM хранятся в защищённом датасете DWH (или в виде криптографических хэшей `SHA256(LOWER(TRIM(email)))`), никогда не отправляясь обратно в теги GA4/Метрики в открытом виде.

### 2.2. Эталонный `#standardSQL` сборки сквозной витрины (`GA4 + Ad Spend + CRM`)

```sql
-- Слой 1: Распаковка сессий и источников из шардированных таблиц GA4
WITH ga4_sessions AS (
  SELECT
    PARSE_DATE('%Y%m%d', event_date) AS session_date,
    TIMESTAMP_MICROS(MIN(event_timestamp)) AS session_start_ts,
    user_pseudo_id AS client_id,
    MAX(user_id) AS user_id,
    CONCAT(
      user_pseudo_id, '_',
      CAST((SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS STRING)
    ) AS full_session_id,
    LOWER(COALESCE(
      (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'source'),
      collected_traffic_source.manual_source, '(direct)'
    )) AS utm_source,
    LOWER(COALESCE(
      (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'medium'),
      collected_traffic_source.manual_medium, '(none)'
    )) AS utm_medium,
    LOWER(COALESCE(
      (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'campaign'),
      collected_traffic_source.manual_campaign_name, '(not set)'
    )) AS utm_campaign,
    COUNTIF(event_name = 'generate_lead') AS web_leads
  FROM `project_id.analytics_123456789.events_*`
  WHERE _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
                          AND FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY))
  GROUP BY 1, 3, 5, 6, 7, 8
),

-- Слой 2: Привязка сделок CRM к последнему непрямому визиту ДО создания сделки
-- (защита от попадания пост-продажных заходов клиента в цепочку атрибуции!)
crm_attributed AS (
  SELECT
    d.deal_id,
    DATE(d.created_at) AS deal_date,
    d.status_code,
    SAFE_CAST(d.revenue_rub AS FLOAT64) AS revenue_rub,
    SAFE_CAST(d.gross_profit_rub AS FLOAT64) AS gross_profit_rub,
    ARRAY_AGG(
      STRUCT(s.utm_source, s.utm_medium, s.utm_campaign)
      ORDER BY (s.utm_source = '(direct)' AND s.utm_medium = '(none)') ASC,
               s.session_start_ts DESC
      LIMIT 1
    )[OFFSET(0)] AS attr
  FROM `project_id.raw_crm.deals` d
  JOIN ga4_sessions s
    ON d.client_id = s.client_id
   AND s.session_start_ts <= d.created_at  -- СТРОГИЙ ФИЛЬТР: отсекаем визиты после покупки!
  GROUP BY 1, 2, 3, 4, 5
),

-- Слой 3: Агрегация каждого источника СТРОГО ДО ЕДИНОГО ЗЕРНА (dt, source, medium, campaign)
sessions_daily AS (
  SELECT session_date AS dt, utm_source, utm_medium, utm_campaign,
         COUNT(DISTINCT full_session_id) AS sessions,
         COUNT(DISTINCT client_id) AS users,
         SUM(web_leads) AS web_leads
  FROM ga4_sessions
  GROUP BY 1, 2, 3, 4
),
crm_daily AS (
  SELECT deal_date AS dt,
         attr.utm_source, attr.utm_medium, attr.utm_campaign,
         COUNT(DISTINCT deal_id) AS crm_leads,
         COUNT(DISTINCT IF(status_code = 'QUALIFIED' OR status_code = 'WON', deal_id, NULL)) AS qual_leads,
         COUNT(DISTINCT IF(status_code = 'WON', deal_id, NULL)) AS paid_deals,
         SUM(IF(status_code = 'WON', revenue_rub, 0)) AS revenue_rub,
         SUM(IF(status_code = 'WON', gross_profit_rub, 0)) AS gross_profit_rub
  FROM crm_attributed
  GROUP BY 1, 2, 3, 4
),
spend_daily AS (
  SELECT dt,
         LOWER(TRIM(utm_source)) AS utm_source,
         LOWER(TRIM(utm_medium)) AS utm_medium,
         LOWER(TRIM(utm_campaign)) AS utm_campaign,
         SUM(impressions) AS impressions,
         SUM(clicks) AS clicks,
         SUM(spend_gross_rub) AS spend_rub
  FROM `project_id.raw_ads.ad_costs_normalized`
  WHERE dt >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
  GROUP BY 1, 2, 3, 4
)

-- Финальная витрина через FULL OUTER JOIN (не теряет ни дни расхода без сделок, ни отложенные сделки без расхода!)
SELECT
  dt, utm_source, utm_medium, utm_campaign,
  COALESCE(sp.impressions, 0) AS impressions,
  COALESCE(sp.clicks, 0) AS clicks,
  COALESCE(sp.spend_rub, 0) AS spend_rub,
  COALESCE(sd.sessions, 0) AS sessions,
  COALESCE(sd.users, 0) AS users,
  COALESCE(sd.web_leads, 0) AS web_leads,
  COALESCE(cd.crm_leads, 0) AS crm_leads,
  COALESCE(cd.qual_leads, 0) AS qual_leads,
  COALESCE(cd.paid_deals, 0) AS paid_deals,
  COALESCE(cd.revenue_rub, 0) AS revenue_rub,
  COALESCE(cd.gross_profit_rub, 0) AS gross_profit_rub
FROM spend_daily sp
FULL OUTER JOIN sessions_daily sd USING (dt, utm_source, utm_medium, utm_campaign)
FULL OUTER JOIN crm_daily cd      USING (dt, utm_source, utm_medium, utm_campaign);
```

---

## 3. Архитектура BI-слоя: Looker Studio vs Power BI и трёхуровневая иерархия отчётов

### 3.1. Две фатальные ловушки `Data Blending` в Looker Studio (Google Data Studio)
Встроенное совмещение источников (`Blend Data`) в Looker Studio по умолчанию работает поверх `LEFT OUTER JOIN` без автоматического приведения зерна:
1. **Ловушка размножения расходов (`Fan-Out / Cartesian Duplication`)**: если соединить таблицу расходов рекламного кабинета с зерном `(Дата, Кампания)` и неагрегированную выгрузку сделок CRM (где за ту же дату и кампанию лежит 6 отдельных строк сделок), строка дневного расхода продублируется 6 раз — дашборд покажет шестикратный перерасход бюджета!
2. **Ловушка потери отложенных продаж (`Missing Left Keys`)**: если слева стоит таблица расходов Яндекс Директа, а в субботу кампания была остановлена (`0 ₽` расхода, строки за субботу нет), но дошедший клиент оплатил счёт в CRM — `LEFT JOIN` молча отбросит субботнюю выручку! И наоборот, если поставить слева CRM, исчезнут все дни и кампании, сжигавшие бюджет с `0` заявок.

**Инженерный стандарт для Looker Studio**: подавать в отчёт **единую предварительно сгруппированную SQL-витрину (`FULL OUTER JOIN` на одном зерне)**, а все относительные показатели (`CTR`, `CPC`, `CPL`, `CAC`, `CR1`, `CR2`, `ROMI`) задавать вычисляемыми полями **на уровне агрегатов BI** (`SUM(spend_rub) / SUM(paid_deals)`), но никогда не `AVG(daily_cac)` (усреднение суточных отношений математически неверно!).

### 3.2. Схема «Звезда» (`Star Schema`) и меры `DAX` в Power BI
В колоночном движке Power BI (`VertiPaq`) сведение разнородных таблиц в одну широкую плоскую простыню неэффективно. Строится каноническая **схема «Звезда»**:
- **Таблицы фактов (`FactCosts`, `FactSessions`, `FactDeals`)** хранятся раздельно на своём естественном зерне; связывать таблицы фактов напрямую между собой (`Many-to-Many`) **запрещено**.
- **Таблицы измерений — справочники-мосты (`DimCalendar`, `DimUTM`, `DimGeo`, `DimDevice`)** содержат строго уникальные ключи в нижнем регистре (`Append` всех ключей из фактов -> `Trim` -> `Lowercase` -> `Remove Duplicates`) и фильтруют все таблицы фактов связями `1:*` сверху вниз.
- Все финансовые коэффициенты вычисляются мерами `DAX` через безопасное деление `DIVIDE([Spend], [PaidDeals], 0)`. Избегать стандартного встроенного коннектора Google Analytics в Power BI из-за скрытого семплирования — подключаться напрямую к BigQuery / ClickHouse / Postgres.

### 3.3. Трёхуровневая ролевая матрица дашбордов
1. **Дашборд собственника / CEO (еженедельный / месячный ритм)**: `Выручка`, `Маржинальная прибыль`, `Общий маркетинговый расход (с НДС и ФОТ/комиссиями)`, `ROMI по прибыли`, `ДРР`, когортный `LTV / CAC` и `Payback Period` без шума ключевых слов.
2. **Дашборд РОПа (ежедневный контроль продаж)**: соблюдение `SLA` первого касания (`<= 15–60 мин`), конверсия в квалификацию и оплату (`CR2`) по каждому менеджеру, доля сделок без заполненной суммы и структура отказов (`дорого`, `недозвон`, `нецелевой лид`, `ушёл к конкуренту`).
3. **Операционный дашборд маркетолога канала (ежедневное управление ставками)**: иерархический срез `Канал -> Кампания -> Группа/Пул -> Объявление/Ключ` от показов и `CTR` до **квалифицированных лидов, оплат и маржинального ROMI** с подсветкой связок-кандидатов на отключение и масштабирование.

---

## 4. Протокол автоматической сверки расхождений (`Reconciliation Gate`)

Расхождения между рекламным кабинетом, веб-аналитикой и БД/CRM неизбежны, но их величина обязана находиться в известных инженерных допусках. Скрипт регулярной сверки (`funnel_reconcile.py`) проверяет за закрытое окно `[today - 8d .. today - 2d]` четыре контрольных инварианта:

| Узел сверки | Формула расхождения | Допустимый коридор | Диагноз при выходе за коридор |
|---|---|---|---|
| **1. Клики кабинета Директа vs Визиты Метрики / Сессии GA4** | $\frac{\text{Clicks} - \text{Visits}}{\text{Clicks}}$ | **`<= 10–15%`** на вебе | `> 20%`: потеря `utm_*`/`yclid` на `http->https` или `www` редиректе, долгая загрузка первого экрана (`LCP > 4s`), блокировка счётчика CSP/AdBlock или ботный фрод в РСЯ |
| **2. Клики кабинета Telegram Ads (медиа) vs `/start` в БД бота** | $\frac{\text{BotStarts}}{\text{CabClicks}}$ | `1–5%` на холодных `Users+Media`, `15–45%` на тексте/каналах | `0%` при `> 30` кликов: сломан обработчик `/start <payload>`, опечатка в username бота или 100% ботный донор |
| **3. Веб-конверсии `lead_submit` (GA4/Метрика) vs Созданные лиды в CRM** | $\frac{|\text{WebLeads} - \text{CRMLeads}|}{\max(\text{WebLeads}, \text{CRMLeads})}$ | **`<= 5–8%`** | Веб > CRM: цель срабатывает на клик по кнопке до валидации формы или падает webhook в amoCRM/Битрикс24. CRM > Веб: не размечены коллтрекинг / мессенджеры / быстрый заказ в 1 клик |
| **4. Доля сделок CRM с непустым `client_id` / `start_param` у онлайн-трафика** | $\frac{\text{Deals with ID}}{\text{Total Online Deals}}$ | **`>= 85–92%`** | `< 80%`: скрытое поле `_ga` / `_ym_uid` не успевает заполниться до отправки формы, перезатирается при переходе между поддоменами или удаляется менеджером вручную (нет флага «Только из API») |
| **5. Выручка `purchase` в GA4/Метрике vs Фактические оплаты эквайринга/БД (за вычетом возвратов)** | $\frac{|\text{GA\_Rev} - \text{DB\_NetRev}|}{\text{DB\_NetRev}}$ | **`<= 3–5%`** (при S2S Measurement Protocol) | `> 10%`: событие `purchase` пушится на странице «Спасибо за заявку» до реального списания карты, дублируется при перезагрузке вкладки (нет дедупликации по `transaction_id`) или не вычитаются отмены/чарджбэки |

При обнаружении расхождения выше критического порога система мониторинга блокирует автоматическое перераспределение бюджетов по искажённым данным и поднимает задачу аудита трекинга (`mkt-tracking-setup`).
