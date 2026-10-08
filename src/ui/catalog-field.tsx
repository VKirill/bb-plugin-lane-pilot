import { SettingField } from "./setting-controls";
import type { LpPage } from "./use-lp-page";

/** A catalog row as an editable field, or nothing when the catalog does not have it. */
export function CatalogField({ page, keyName }: { page: LpPage; keyName: string }) {
  const { catalogRow, displayedValue, applySetting, writeDraft } = page;
  const row = catalogRow(keyName);
  return row ? <SettingField row={row} value={displayedValue(keyName)} disabled={false}
    onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft(keyName, next)} /> : null;
}

/** Several rows of the catalog in the given order. */
export function CatalogFields({ page, keys }: { page: LpPage; keys: readonly string[] }) {
  return <>{keys.map((key) => <CatalogField key={key} page={page} keyName={key} />)}</>;
}
