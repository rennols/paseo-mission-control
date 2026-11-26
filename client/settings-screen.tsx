/**
 * Settings, Plugins, Mission Control. P0 holds the watchdog thresholds (per host). Slot limits,
 * test patterns, quick replies and saved prompts join with their features.
 */
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { DEFAULT_WATCHDOG_SETTINGS, watchdogSettings, type WatchdogSettings } from "../shared/settings";

type Field = Exclude<keyof WatchdogSettings, "collisionRadar">;

const RADAR_OPTIONS: { label: string; value: WatchdogSettings["collisionRadar"] }[] = [
  { label: "Same lines", value: "lines" },
  { label: "Same file", value: "files" },
  { label: "Off", value: "off" },
];

const FIELDS: { key: Field; label: string; hint: string; unit: string; min: number; max: number }[] = [
  { key: "sameErrorTurns", label: "Same-error repeats before Stuck", hint: "Turns in a row that hit the same error.", unit: "turns", min: 2, max: 20 },
  { key: "idleTurns", label: "Turns without file changes before Stuck", hint: "Turns you started that changed no files.", unit: "turns", min: 2, max: 50 },
  { key: "timeLimitMinutes", label: "Time limit per agent", hint: "A run longer than this shows as Over time.", unit: "min", min: 5, max: 1440 },
];

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(watchdogSettings);
  const [draft, setDraft] = useState<Record<Field, string> | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (settings.status === "ready" && draft === null) {
      setDraft({
        sameErrorTurns: String(settings.values.sameErrorTurns),
        idleTurns: String(settings.values.idleTurns),
        timeLimitMinutes: String(settings.values.timeLimitMinutes),
      });
    }
  }, [settings, draft]);

  if (settings.status === "loading" || draft === null) {
    if (settings.status === "invalid" || settings.status === "error") {
      return (
        <SettingsSection title="Watchdog">
          <SettingsCard>
            <SettingsAction
              label="Saved settings could not be read"
              hint={String(settings.error)}
              actionLabel="Reset to defaults"
              onPress={() => void settings.reset()}
            />
          </SettingsCard>
        </SettingsSection>
      );
    }
    return <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text>;
  }

  const radarMode: WatchdogSettings["collisionRadar"] = settings.status === "ready" ? settings.values.collisionRadar : "lines";
  const errors: Partial<Record<Field, string>> = {};
  const parsed = { collisionRadar: radarMode } as WatchdogSettings;
  for (const field of FIELDS) {
    const value = Number(draft[field.key]);
    if (!Number.isInteger(value) || value < field.min || value > field.max) {
      errors[field.key] = `Enter a whole number from ${field.min} to ${field.max}.`;
    } else {
      parsed[field.key] = value;
    }
  }
  const valid = Object.keys(errors).length === 0;
  const dirty =
    settings.status === "ready" && FIELDS.some((field) => String(settings.values[field.key]) !== draft[field.key]);

  async function save(): Promise<void> {
    if (!valid || settings.status !== "ready") return;
    const saved = await settings.save({ ...parsed, collisionRadar: settings.values.collisionRadar }, settings.revision);
    if (saved) {
      setMessage("Saved. The watchdog uses the new limits from the next turn.");
    } else {
      setMessage(settings.saveError ? String(settings.saveError) : "Not saved: the settings changed elsewhere. Reload and try again.");
    }
  }

  return (
    <SettingsSection title="Watchdog" info="The watchdog only flags agents in Needs you. It never pauses or stops them.">
      <SettingsCard>
        {FIELDS.map((field) => (
          <SettingsInput
            key={field.key}
            label={`${field.label} (${field.unit})`}
            hint={`${field.hint} Default ${DEFAULT_WATCHDOG_SETTINGS[field.key]}.`}
            error={errors[field.key]}
            initialValue={draft[field.key]}
            onChangeText={(text) => {
              setMessage(null);
              setDraft((current) => (current ? { ...current, [field.key]: text.trim() } : current));
            }}
          />
        ))}
        <SettingsAction
          label={message ?? (dirty ? "Unsaved changes" : "Saved on this host")}
          actionLabel="Save"
          disabled={!valid || !dirty || settings.saving}
          onPress={() => void save()}
        />
        <SettingsSelect
          label="Collision radar"
          hint="Flags two agents in different worktrees of one repo that edit the same lines (or any same file). It only flags. Saves as soon as you pick."
          value={radarMode}
          options={RADAR_OPTIONS}
          disabled={settings.saving || settings.status !== "ready"}
          onValueChange={(value) => {
            if (settings.status !== "ready") return;
            void settings.save({ ...settings.values, collisionRadar: value }, settings.revision).then((saved) => {
              setMessage(saved ? "Saved. The radar uses it from the next turn." : "Not saved: the settings changed elsewhere. Reload and try again.");
            });
          }}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
