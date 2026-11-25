/**
 * Settings, Plugins, Mission Control, Queue: slot limit, the unattended stop and the overnight
 * window for the overnight report, per host.
 */
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { CLOCK_TIME, queueSettings, type QueueSettings } from "../shared/settings";

type Field = keyof QueueSettings;
type NumberField = "slotLimit" | "unattendedStopMinutes";
type TimeField = "overnightStart" | "overnightEnd";

type FieldSpec =
  | { kind: "number"; key: NumberField; label: string; hint: string; unit: string; min: number; max: number }
  | { kind: "time"; key: TimeField; label: string; hint: string };

const FIELDS: FieldSpec[] = [
  { kind: "number", key: "slotLimit", label: "Slot limit", hint: "Agents working, waiting on you or stuck at once on this host.", unit: "agents", min: 1, max: 20 },
  {
    kind: "number",
    key: "unattendedStopMinutes",
    label: "Stop queue runs with no file changes after",
    hint: "Interrupts the run to free its slot. The agent and its chat stay.",
    unit: "min",
    min: 15,
    max: 1440,
  },
  { kind: "time", key: "overnightStart", label: "Overnight window starts", hint: "24-hour clock, this host's time. The overnight report on the Queue tab covers this window." },
  { kind: "time", key: "overnightEnd", label: "Overnight window ends", hint: "24-hour clock. An end before the start means the next morning." },
];

function fieldLabel(field: FieldSpec): string {
  return field.kind === "number" ? `${field.label} (${field.unit})` : `${field.label} (HH:MM)`;
}

export function QueueSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(queueSettings);
  const [draft, setDraft] = useState<Record<Field, string> | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (settings.status === "ready" && draft === null) {
      setDraft({
        slotLimit: String(settings.values.slotLimit),
        unattendedStopMinutes: String(settings.values.unattendedStopMinutes),
        overnightStart: settings.values.overnightStart,
        overnightEnd: settings.values.overnightEnd,
      });
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
    if (field.kind === "time") {
      const text = draft[field.key];
      // Accept "7:00" as "07:00".
      const padded = /^\d:\d\d$/.test(text) ? `0${text}` : text;
      if (!CLOCK_TIME.test(padded)) errors[field.key] = "Enter a time from 00:00 to 23:59, for example 22:00.";
      else parsed[field.key] = padded;
      continue;
    }
    const value = Number(draft[field.key]);
    if (!Number.isInteger(value) || value < field.min || value > field.max) errors[field.key] = `Enter a whole number from ${field.min} to ${field.max}.`;
    else parsed[field.key] = value;
  }
  const valid = Object.keys(errors).length === 0;
  const dirty = settings.status === "ready" && FIELDS.some((field) => String(settings.values[field.key]) !== draft[field.key]);

  async function save(): Promise<void> {
    if (!valid || settings.status !== "ready") return;
    const saved = await settings.save(parsed, settings.revision);
    setMessage(saved ? "Saved. The queue and the overnight report use the new values now." : settings.saveError ? String(settings.saveError) : "Not saved: the settings changed elsewhere. Reload and try again.");
  }

  return (
    <SettingsSection title="Queue" info="Queued tasks start in order when a slot is free on this host. The overnight report lists what ran in the overnight window.">
      <SettingsCard>
        {FIELDS.map((field) => (
          <SettingsInput
            key={field.key}
            label={fieldLabel(field)}
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
