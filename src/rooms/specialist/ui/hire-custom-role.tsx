import { useState } from "react";
import { t } from "@lane-pilot/i18n";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  CONTROL_H,
  Input,
  Label,
  Surface,
  SurfaceBody,
  SurfaceHeader,
} from "@lane-pilot/ui-kit";
import { PROFILE_ID_RE } from "./hire-wizard-helpers";

/** Inline custom role form reusing the OwnedSettings `save_agent_profile` fields (ID, description, instructions). */
export function HireCustomRoleForm({
  existingIds,
  busy,
  error,
  onSave,
  onCancel,
}: {
  existingIds: ReadonlySet<string>;
  busy: boolean;
  error: string | null;
  onSave: (draft: { id: string; description: string; prompt: string }) => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");

  const trimmedId = id.trim();
  const idValid = PROFILE_ID_RE.test(trimmedId);
  const idTaken = existingIds.has(trimmedId);
  const canSave = !busy && idValid && !idTaken && description.trim().length > 0 && prompt.trim().length > 0;

  return (
    <Surface testId="hire-custom-role-form" className="mt-3">
      <SurfaceHeader>
        <h3 className="text-sm font-semibold text-foreground">{t("consoleHireCustomRoleTitle")}</h3>
      </SurfaceHeader>
      <SurfaceBody className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="hire-custom-id" className="text-xs font-medium">
            {t("owned13")}
          </Label>
          <Input
            id="hire-custom-id"
            className={`${CONTROL_H} w-full`}
            data-testid="hire-custom-id"
            placeholder="my-agent"
            value={id}
            onChange={(event) => setId(event.target.value)}
          />
          {trimmedId && !idValid ? (
            <p className="text-xs text-destructive-text">{t("consoleHireCustomInvalidId")}</p>
          ) : idTaken ? (
            <p className="text-xs text-destructive-text">{t("consoleHireCustomIdTaken")}</p>
          ) : null}
        </div>

        <div className="space-y-1">
          <Label htmlFor="hire-custom-description" className="text-xs font-medium">
            {t("owned15")}
          </Label>
          <Input
            id="hire-custom-description"
            className={`${CONTROL_H} w-full`}
            data-testid="hire-custom-description"
            maxLength={400}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="hire-custom-prompt" className="text-xs font-medium">
            {t("agentSectionInstructions")}
          </Label>
          <textarea
            id="hire-custom-prompt"
            className="min-h-28 w-full rounded-xl border border-[var(--lp-outline)] bg-[var(--lp-card)] p-3 text-sm"
            data-testid="hire-custom-prompt"
            maxLength={32000}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </div>

        {error ? (
          <Alert variant="destructive" data-testid="hire-custom-error">
            <AlertTitle>{t("consoleHireCustomFailed")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!canSave}
            data-testid="hire-custom-save"
            onClick={() =>
              onSave({ id: trimmedId, description: description.trim(), prompt: prompt.trim() })
            }
          >
            {busy ? t("owned17") : t("consoleHireCustomSave")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            data-testid="hire-custom-cancel"
            onClick={onCancel}
          >
            {t("consoleHireCustomCancel")}
          </Button>
        </div>
      </SurfaceBody>
    </Surface>
  );
}
