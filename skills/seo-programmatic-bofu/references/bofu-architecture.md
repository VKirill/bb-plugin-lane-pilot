# Архитектура BOFU-страниц Programmatic SEO, реляционная схема БД и Handoff-контракт в `bb cf`

- **Целевой скилл:** `seo-programmatic-bofu`
- **Источник синтеза:** Пакет `ai-programmatic-seo-2026` (Алексей Борисов, Алмас Абулхаиров — кейсы `invoisin.com`, `visatosingapore.com`, `almas.vc`) + сверка с Каноном #1 (DrMax GIST / TGA / защита от Scaled Content Abuse).

---

## 1. Принцип BOFU-приоритизации при низком авторитете домена (DR 0–20)

Когда новый продукт или домен стартует с `Ahrefs DR = 0..15`, лобовая атака на высокочастотные категорийные запросы (`head terms` с `KD 50+`, например `billing software` или `time tracking app`) приводит к нулевому результату в течение 6–12 месяцев.

### 1.1. Каноническая очередь приоритетов (от быстрых денег к охвату)
1. **Уровень P0 — Перехват горячего переключения и миграции (`Competitor Switch / Migration / Pricing`):**
   - Запросы вида `import from X`, `how to migrate from X`, `X pricing`, `X vs Y`, `X alternative`.
   - *Почему работает на DR 0:* В кейсе `invoisin.com` на кластер Harvest пришлось **80,6% всех ранжирующихся позиций сайта** (25 из 31 строки в Ahrefs Rank Tracker, 9 в ТОП-10 US/GB). Даже ключи с табличным `Volume = 0..10` (`import harvest data via api`, `harvest invoice import`) вышли в ТОП-3..10 и привели платящих B2B-клиентов с чеками на команды по 8+ рабочих мест и переносом 1 300+ документов.
2. **Уровень P1 — Узкие отраслевые и ролевые сегменты (`Persona / ICP / Use-Case`):**
   - Запросы вида `best invoicing software for agencies`, `time tracking software for consultants`, `billing software for law firms`, либо гео-специфичные страницы под гражданство/юрисдикцию (`Singapore visa for citizens of Kazakhstan / Nigeria`).
   - Высокий коммерческий CPC ($7–$23+) при низком `KD (0–15)`.
3. **Уровень P2 — Редактируемые шаблоны и прикладные интеграции (`Editable Templates & Integrations X + Y`):**
   - Запросы вида `consulting invoice template`, `contractor invoice template`, `X + QuickBooks integration`.
   - Работают только если страница даёт готовый интерактивный генератор или скачиваемый рабочий файл (`CSV/XLSX/PDF/Docs`), а не текстовое описание «что такое инвойс».
4. **Уровень P3 — Интерактивные микро-инструменты (`Free Calculators / Checkers` как Link Magnets):**
   - Запросы вида `billable hours calculator`, `timesheet calculator`, `visa photo checker`, `Telegram Ads ROI calculator`.
   - Привлекают естественные ссылки и формируют верхний/средний слой воронки (`Product Engineering as Marketing`).
5. **Уровень P4 — Широкие категорийные страницы (`Core Category Head Terms`):**
   - Осваиваются по мере накопления ссылочного веса домена (`DR 25+`) и внутренней ссылочной массы от кластеров P0–P3.

### 1.2. Формула скоринга кластера перед запуском в разработку
$$\text{ClusterScore} = \text{Demand}_{\text{real}} \times \text{BusinessFit}_{(1..5)} \times \text{IntentFit}_{(1..5)} \times \text{Feasibility}_{(KD, SERP)}$$

- **Фильтр отсечения (`Off-ICP Trap Filter`):** Если `BusinessFit < 3` (например, запрос `auto repair invoice template` или `medical billing` для SaaS, созданного под консалтинговые агентства), кластер помечается в `raw-keywords.csv` тегом `off-icp` и **не допускается** к генерации URL, даже при `Volume = 5 000` и `KD = 1`.

---

## 2. Пять канонических BOFU-архетипов страниц и их структура

Каждый кластер конкурента или сегмента **запрещено** сливать в одну перегруженную «энциклопедию» или размножать по 10 почти одинаковых doorway-страниц. Разделение идёт строго по **задаче пользователя (Job-to-be-Done)** внутри топологии `Hub ↔ Spoke`.

```text
                    [HUB: /vs/harvest] (Alternative & Overview)
                     ↙              ↓                        ↘
     [/harvest-pricing]      [/harvest-import]       [/import-from-harvest]
     (Sourced Pricing)       (Migration Guide)       (Interactive Importer)
             ↘                      ↓                        ↙
                         [CONVERSION: /signup]
```

### Архетип 1: Head-to-Head Comparison (`X vs Y` — `/vs/harvest-vs-tsheets`, `/vs/toggl`)
- **Поисковый интент:** Пользователь выбирает между двумя конкретными продуктами или ищет замену с конкретной функцией (`toggl invoice`).
- **Обязательная структура блоков:**
  1. `H1 + Direct Promise`: честное позиционирование сравнения за 1 экран;
  2. `Who Each Product Is Best For`: кому объективно лучше подойдёт продукт X, кому продукт Y, а кому ваш продукт (признание сильных сторон конкурента критично для доверия!);
  3. `Verified Decision Matrix`: сравнительная таблица только по проверяемым параметрам (без субъективных «лучший», «в 10 раз быстрее»);
  4. `Honest Competitor Strengths`: в каких сценариях конкурент реально силён;
  5. `Product Differentiators & Proof`: реальные скриншоты UI и проверяемые отличия вашего продукта;
  6. `Sourced Pricing Breakdown`: расчёт стоимости на типовые размеры команд (например, 1, 5, 10, 25 мест) с прямой ссылкой на официальный прайс конкурента и датой проверки (`checked_at`);
  7. `Migration Path Block`: блок снижения страха перехода со ссылкой на `/import-from-X`;
  8. `Objection FAQ`: ответы на реальные вопросы при выборе;
  9. `Contextual CTA`: *«Сравнить на своих данных»* / *«Проверить импорт за 2 минуты»*.
- **Правило ребрендингов конкурентов:** Если конкурент сменил название (например, `TSheets → QuickBooks Time`), **не создавайте** конкурирующий дубль URL. Обновите единого канонического владельца (`/vs/harvest-vs-tsheets`), включив двойное именование *«QuickBooks Time (formerly TSheets)»* и ссылку на официальную страницу ребрендинга.

### Архетип 2: Alternatives Hub (`X alternative` / `X competitors` — `/vs/harvest`)
- **Поисковый интент:** Пользователь недоволен продуктом X (например, из-за резкого роста цен) и формирует шортлист из 3–5 альтернатив по критериям.
- **Обязательная структура блоков:**
  1. `Root Cause Analysis`: почему команды ищут альтернативу X (с подтверждёнными фактами о тарифах/ограничениях);
  2. `Evaluation Criteria Table`: матрица критериев выбора для целевого ICP;
  3. `Categorized Alternatives Breakdown`: разбор альтернатив по сценариям («лучше для фрилансера», «лучше для сервисного агентства», «лучше для enterprise»);
  4. `Interactive Cost / Switching Calculator`: быстрый расчёт экономии или времени перехода;
  5. `Spoke Navigation Hub`: контекстные ссылки на детальный разбор цен (`/X-pricing`), инструкцию по переходу (`/X-import`) и интерактивный импортер (`/import-from-X`).

### Архетип 3: Migration Guide & Interactive Importer (`/X-import` + `/import-from-X`)
Самый конверсионный BOFU-архетип в B2B SaaS (снимает главный барьер — `Switching Cost`). Делится на две связанные страницы при наличии раздельного информационного и транзакционного спроса:
- **3A. Информационный гайд (`/harvest-import` / `/guides/import-all-data-from-harvest-api`):**
  - Закрывает запросы `how to migrate from X`, `export data from X`, `X api import`.
  - Показывает пошаговую схему экспорта/API-подключения, риски потери истории и таблицу соответствия полей.
  - CTA: *«Посмотреть интерактивный превью импорта»*.
- **3B. Транзакционный Product-Led лендинг импорта (`/import-from-harvest`):**
  - Закрывает запросы `import from X`, `X invoice import`, `switch from X to [Brand]`.
  - **Встроенный интерактивный пайплайн ДО регистрации:**
    `Upload CSV / Connect API → Interactive Preview (показ точного числа найденных клиентов, проектов, инвойсов и дублей) → Duplicate Resolution Rules → Confirm → Signup & Auto-Import`.
  - **Обязательный чек-лист прозрачности на странице:**
    - Что именно переносится (клиенты, проекты, задачи, таймшиты, инвойсы);
    - Что **не** переносится (и почему);
    - Как система обрабатывает дубликаты до записи в БД;
    - Сколько шагов и минут занимает процедура;
    - Куда обратиться при нестандартном архиве данных.

### Архетип 4: Sourced Pricing Explainer (`X pricing` — `/harvest-pricing`)
- **Поисковый интент:** Понять реальную полную стоимость использования продукта X (включая платные аддоны, лимиты проектов/клиентов, разницу при помесячной и годовой оплате).
- **Обязательная структура блоков:**
  1. `Official Tiers Summary` (с точной датой проверки `checked_at` и ссылкой на официальный URL прайса);
  2. `Interactive Team Cost Calculator` (ползунок числа сотрудников и типа оплаты → расчёт годового TCO по открытой формуле);
  3. `Known Limits & Hidden Bottlenecks` (запрещено выдумывать скрытые комиссии — указывать только документированные лимиты из официального Help Center);
  4. `TCO Comparison vs [Our Product]`;
  5. `Contextual CTA`: *«Посчитать стоимость для вашей команды»*.

### Архетип 5: Persona / Industry / Integration Pages (`/time-tracking/agencies`, `/invoicing/law-firms`, `/visa/nigeria`)
- **Поисковый интент:** Пользователь ищет решение, адаптированное под правила, терминологию и ограничения его конкретной отрасли, роли или страны гражданства.
- **Обязательная структура блоков:**
  1. `Specific Context & Compliance Rules`: реальные требования отрасли/юрисдикции (например, форма A14 и бесплатная Singapore Arrival Card для конкретного паспорта, либо учёт billable hours по ставкам партнёров/юристов для `law firms`);
  2. `Tailored Workflow Diagram` (в стиле предметной причинно-следственной схемы Excalidraw);
  3. `Embedded Role-Specific Tool / Template / Quiz` (например, квиз проверки визы по паспорту или шаблон инвойса для консультанта);
  4. `Verified Case Study / Social Proof` с реальными цифрами;
  5. `Direct Action CTA`: продолжение задачи пользователя.

---

## 3. Реляционная схема базы данных для Programmatic SEO

Чтобы исключить расхождение цен, битые ссылки и галлюцинации AI при генерации и обновлении сотен страниц, все факты хранятся в нормализованной реляционной структуре (PostgreSQL / SQLite / структурированные YAML-реестры в репозитории).

```sql
-- 1. Справочник сущностей (конкуренты, интеграции, страны, индустрии)
CREATE TABLE pseo_entities (
    entity_id          UUID PRIMARY KEY,
    entity_type        VARCHAR(32) NOT NULL CHECK (entity_type IN ('competitor', 'integration', 'persona_icp', 'country_jurisdiction', 'template_category')),
    slug               VARCHAR(128) UNIQUE NOT NULL,
    canonical_name     VARCHAR(255) NOT NULL,
    former_names       TEXT[], -- например: ARRAY['TSheets'] для QuickBooks Time
    official_site_url  TEXT,
    official_price_url TEXT,
    official_docs_url  TEXT,
    best_for_summary   TEXT NOT NULL,
    honest_strengths   JSONB NOT NULL DEFAULT '[]', -- честные плюсы конкурента
    known_limitations  JSONB NOT NULL DEFAULT '[]', -- документированные ограничения
    trademark_notice   TEXT,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Реестр проверяемых изменчивых фактов (Fresh Facts с датой и источником)
CREATE TABLE pseo_entity_facts (
    fact_id             UUID PRIMARY KEY,
    entity_id           UUID NOT NULL REFERENCES pseo_entities(entity_id) ON DELETE CASCADE,
    fact_key            VARCHAR(128) NOT NULL, -- например: 'seat_price_monthly_usd', 'free_tier_limit'
    claim_value         TEXT NOT NULL,         -- например: '$12 per seat/month'
    calculation_formula TEXT,                  -- открытая формула расчёта, если применимо
    wording_template    TEXT NOT NULL,         -- формулировка с оговоркой «по данным на [checked_at]»
    official_source_url TEXT NOT NULL,         -- обязательный URL официального источника
    checked_at          DATE NOT NULL,         -- дата последней ручной/агентской верификации
    max_stale_days      INT NOT NULL DEFAULT 30,
    owner_role          VARCHAR(64) NOT NULL,  -- например: 'product_expert'
    UNIQUE (entity_id, fact_key)
);

-- 3. Реестр уникальных интерактивных модулей (GIST / Information Gain Assets)
CREATE TABLE pseo_unique_modules (
    module_id           UUID PRIMARY KEY,
    module_code         VARCHAR(128) UNIQUE NOT NULL, -- например: 'harvest_csv_preview_importer', 'timesheet_7day_calc'
    module_type         VARCHAR(32) NOT NULL CHECK (module_type IN (
                            'interactive_importer', 'calculator', 'decision_matrix',
                            'editable_template', 'eligibility_quiz', 'live_ui_sandbox'
                        )),
    component_path      TEXT NOT NULL, -- путь к ViewComponent / React / Rails partial
    input_schema_json   JSONB NOT NULL,
    output_schema_json  JSONB NOT NULL,
    standalone_value_ok BOOLEAN NOT NULL DEFAULT FALSE, -- Gate: полезна ли страница без SEO-текста?
    cta_label           VARCHAR(255) NOT NULL,
    cta_target_path     VARCHAR(255) NOT NULL
);

-- 4. Карта владения кластерами и страницами (One Intent = One Canonical URL)
CREATE TABLE pseo_clusters_ownership (
    cluster_id          UUID PRIMARY KEY,
    canonical_path      VARCHAR(255) UNIQUE NOT NULL, -- например: '/vs/harvest'
    page_type           VARCHAR(32) NOT NULL CHECK (page_type IN (
                            'comparison', 'alternative', 'migration_guide', 'migration_importer',
                            'pricing', 'persona_icp', 'template', 'calculator', 'category', 'guide'
                        )),
    primary_intent      VARCHAR(32) NOT NULL CHECK (primary_intent IN ('transactional', 'commercial', 'informational', 'navigational')),
    primary_keyword     VARCHAR(255) NOT NULL,
    supporting_keywords TEXT[] NOT NULL DEFAULT '{}',
    country_targets     VARCHAR(8)[] NOT NULL DEFAULT ARRAY['US', 'GB'],
    business_fit        SMALLINT NOT NULL CHECK (business_fit BETWEEN 1 AND 5),
    priority_tier       VARCHAR(4) NOT NULL CHECK (priority_tier IN ('P0', 'P1', 'P2', 'P3', 'P4')),
    status              VARCHAR(16) NOT NULL CHECK (status IN (
                            'idea', 'planned', 'draft', 'ready', 'live', 'discovered', 'indexed', 'improving'
                        )),
    primary_entity_id   UUID REFERENCES pseo_entities(entity_id),
    secondary_entity_id UUID REFERENCES pseo_entities(entity_id),
    unique_module_id    UUID NOT NULL REFERENCES pseo_unique_modules(module_id),
    hub_path            VARCHAR(255), -- ссылка на родительский Hub
    spoke_paths         TEXT[] NOT NULL DEFAULT '{}', -- список дочерних Spokes
    rotating_links_pool TEXT[] NOT NULL DEFAULT '{}', -- пул ротации для шаблонов
    last_qa_passed_at   TIMESTAMPTZ
);
```

---

## 4. Handoff-контракт: Передача спецификации из `seo-programmatic-bofu` в `bb-plugin-content-factory` (`bb cf`)

Скилл `seo-programmatic-bofu` **не дублирует** пайплайн написания текста `bb-plugin-content-factory` (`bb cf`). Вместо этого `seo-programmatic-bofu` выступает **архитектором данных и контролёром канонического владения**:
1. Проверяет, что в `pseo_clusters_ownership` нет другого URL под тот же `SERP-intent`;
2. Проверяет, что `business_fit >= 3`, `unique_module_id` привязан и проходит гейт `standalone_value_ok = true`;
3. Проверяет, что все связанные `pseo_entity_facts` не просрочены (`CURRENT_DATE - checked_at <= max_stale_days`);
4. Генерирует контрактный файл `page-specs/<slug>.yaml` и вызывает `bb cf` для сборки текстового слоя вокруг модуля.

### 4.1. Канонический YAML-контракт `PageSpec` для передачи в `bb cf`
```yaml
page_spec_version: "2026.1"
target_engine: "bb-plugin-content-factory"
page_name: "Harvest to Invoisin Migration Importer"
canonical_path: "/import-from-harvest"
status: "planned" # переводится в 'ready' только после QA-гейта
page_type: "migration_importer"
priority_tier: "P0"

intent_and_demand:
  primary_intent: "transactional"
  audience_icp: "Service agencies and consulting teams (5-50 seats) leaving Harvest after price increases"
  country_targets: ["US", "GB"]
  primary_keyword: "import from harvest"
  supporting_keywords:
    - "harvest invoice import"
    - "switch from harvest to invoisin"
    - "transfer harvest timesheets and invoices"
  business_fit: 5

value_architecture:
  promise: "Загрузите экспорт Harvest и проверьте превью переноса всех клиентов, проектов и инвойсов ещё до создания аккаунта."
  proof:
    - "Реальный кейс: импорт 93 клиентов и 1 320 документов за одну сессию после превью"
    - "Автоматическое распознавание дубликатов до записи в рабочую базу"
  unique_module:
    module_code: "harvest_csv_preview_importer"
    module_type: "interactive_importer"
    component_path: "app/views/migrations/_harvest_preview_uploader.html.erb"
    standalone_value_verified: true
  conversion:
    cta_label: "Загрузить экспорт Harvest и посмотреть превью"
    cta_target: "/import-from-harvest#uploader"
    post_preview_action: "/signup?source=harvest_import_preview"

fact_slots:
  product_facts:
    - claim: "Поддерживается перенос клиентов, проектов, ставок, таймшитов и истории инвойсов"
      verified_against_ui: true
    - claim: "Превью новых записей, обновлений и дублей доступно без регистрации и ввода карты"
      verified_against_ui: true
  fresh_facts:
    - fact_key: "harvest_teams_seat_price"
      claim: "Базовый тариф Harvest Teams составляет $12 за место в месяц при помесячной оплате"
      official_source_url: "https://www.getharvest.com/pricing"
      checked_at: "2026-07-25"
      wording_rule: "Обязательно указывать «по данным официального прайс-листа на 25 июля 2026»"
      owner: "product_expert"
    - fact_key: "harvest_csv_export_format"
      claim: "Экспорт таймшитов и инвойсов в Harvest доступен в форматах CSV и Excel из раздела Reports / Invoices"
      official_source_url: "https://support.getharvest.com/"
      checked_at: "2026-07-25"
      wording_rule: "Ссылка на официальную документацию экспорта"
      owner: "product_expert"

graph_and_schema:
  hub_path: "/vs/harvest"
  internal_links_in:
    - from_path: "/vs/harvest"
      anchor_text: "попробовать интерактивный импорт из Harvest до регистрации"
    - from_path: "/harvest-pricing"
      anchor_text: "перенести историю инвойсов и таймшитов из Harvest"
    - from_path: "/harvest-import"
      anchor_text: "открыть загрузчик экспорта Harvest с превью"
  internal_links_out:
    - to_path: "/vs/harvest"
      anchor_text: "полное сравнение Invoisin и Harvest"
    - to_path: "/harvest-pricing"
      anchor_text: "разбор тарифов Harvest на 2026 год"
    - to_path: "/harvest-import"
      anchor_text: "пошаговая инструкция по экспорту данных из Harvest"
  json_ld_schema_types:
    - "SoftwareApplication"
    - "HowTo"
    - "FAQPage"

bb_cf_generation_constraints:
  require_drmax_gist_compliance: true
  forbid_unverified_claims: true
  forbid_superlative_marketing_fluff: true # запрещены "лучший", "в 10 раз дешевле", "без лимитов" без формулы
  require_excalidraw_causal_diagram: true
  require_claims_audit_output: true
```

### 4.2. Обязательный возвращаемый отчёт от `bb cf` после генерации (`Claims & Overlap Audit`)
При завершении генерации текста по `PageSpec` конвейер обязан вернуть вместе с черновиком структурированный блок проверки:
1. `factual_claims_list[]` — полный перечень всех фактических утверждений в тексте с пометкой типа (`product_fact` | `sourced_external_fact` | `editorial_inference`);
2. `missing_evidence_warnings[]` — какие данные не нашлись в `fact_slots` (запрещено додумывать их из памяти модели!);
3. `intent_overlap_check` — нет ли смыслового дублирования с соседними страницами кластера (`/vs/harvest`, `/harvest-import`, `/harvest-pricing`);
4. `injected_internal_links[]` — подтверждение вставки всех входящих и исходящих контекстных ссылок из `graph_and_schema`.
