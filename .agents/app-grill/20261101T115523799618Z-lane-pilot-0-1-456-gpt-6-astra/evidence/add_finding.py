from pathlib import Path
import sys,re,datetime
p=Path(__file__).resolve().parents[1]/'report.md'
card=sys.stdin.read();s=p.read_text();s=s.replace('<!-- findings:end -->',card+'\n<!-- findings:end -->');n=len(re.findall(r'### F-\d+',s));s=re.sub(r'Подтверждено: \d+\.',f'Подтверждено: {n}.',s);s=s.replace('## 9. Передача',f'| {datetime.datetime.now(datetime.timezone.utc).strftime("%H:%M")} | {re.search(r"F-\d+",card).group()} | Карточка добавлена; доказательство записано до перехода к следующей зоне |\n\n## 9. Передача');p.write_text(s)
