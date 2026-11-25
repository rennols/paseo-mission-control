/**
 * Settings, Plugins, Mission Control, Queue: slot limit and the unattended stop, per host.
 */
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { queueSettings, type QueueSettings } from "../shared/settings";

type Field = keyof QueueSettings;

const FIELDS: { key: Field; label: string; hint: string; unit: string; min: number; max: number }[] = [
  { key: "slotLimit", label: "Slot limit", hint: "Agents working, waiting on you or stuck at once on this host.", unit: "agents", min: 1, max: 20 },
  {
    key: "unattendedStopMinutes",
    label: "Stop queue runs with no file changes after",
    hint: "Interrupts the run to free its slot. The agent and its chat stay.",
    unit: "min",
    min: 15,
    max: 1440,
  },
];

export function QueueSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(queueSettings);
  const [draft, setDraft] = useState<Record<Field, string> | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (settings.status === "ready" && draft === null) {
      setDraft({ slotLimit: String(settings.values.slotLimit), unattendedStopMinutes: String(settings.values.unattendedStopMinutes) });
    }
  }, [settings, draft]);

  if (settings.status === "loading" || draft === null) {
    if (settings.status === "invalid" || settings.status === "error") {
      return (
        <SettingsSection title="Queue">
          <SettingsCard>
            <SettingsAction label="Saved settings could not be read" hint={String(settings.error)} actionLabel="Reset to defaults" onPress={() => void settings.reset()} />
          </SettingsCard>
        </SettingsSection>
      );
    }
    return <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text>;
  }

  const errors: Partial<Record<Field, string>> = {};
  const parsed = {} as QueueSettings;
  for (const field of FIELDS) {
    const value = Number(draft[field.key]);
    if (!Number.isInteger(value) || value < field.min || value > field.max) errors[field.key] = `Enter a whole number from ${field.min} to ${field.max}.`;
    else parsed[field.key] = value;
  }
  const valid = Object.keys(errors).length === 0;
  const dirty = settings.status === "ready" && FIELDS.some((field) => String(settings.values[field.key]) !== draft[field.key]);

  async function save(): Promise<void> {
    if (!valid || settings.status !== "ready") return;
    const saved = await settings.save(parsed, settings.revision);
    setMessage(saved ? "Saved. The queue uses the new limits now." : settings.saveError ? String(settings.saveError) : "Not saved: the settings changed elsewhere. Reload and try again.");
  }

  return (
    <SettingsSection title="Queue" info="Queued tasks start in order when a slot is free on this host.">
      <SettingsCard>
        {FIELDS.map((field) => (
          <SettingsInput
            key={field.key}
            label={`${field.label} (${field.unit})`}
            hint={field.hint}
            error={errors[field.key]}
            initialValue={draft[field.key]}
            onChangeText={(text) => {
              setMessage(null);
              setDraft((current) => (current ? { ...current, [field.key]: text.trim() } : current));
            }}
          />
        ))}
        <SettingsAction label={message ?? (dirty ? "Unsaved changes" : "Saved per host")} actionLabel="Save" disabled={!valid || !dirty || settings.saving} onPress={() => void save()} />
      </SettingsCard>
    </SettingsSection>
  );
}
