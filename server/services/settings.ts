import { zSettings, type Settings, type SettingsPatch } from "../../shared/schemas";
import { systemTimeZone } from "../../shared/time";
import type { Database } from "../db/database";
import { DomainError } from "../domain/context";

export function defaultSettings(): Settings {
  return zSettings.parse({ timeZone: systemTimeZone() });
}

export function loadSettings(db: Database): Settings {
  const row = db.get<{ data: string }>("SELECT data FROM settings WHERE id = 1");
  if (!row) return defaultSettings();
  try {
    const parsed = zSettings.safeParse({ timeZone: systemTimeZone(), ...JSON.parse(row.data) });
    if (parsed.success) return parsed.data;
  } catch {
    // fall through to defaults
  }
  return defaultSettings();
}

export function saveSettings(db: Database, settings: Settings): Settings {
  const valid = zSettings.parse(settings);
  db.run(
    `INSERT INTO settings (id, data, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    JSON.stringify(valid),
    new Date().toISOString(),
  );
  return valid;
}

export function patchSettings(db: Database, patch: SettingsPatch): Settings {
  const current = loadSettings(db);
  const merged = {
    ...current,
    ...patch,
    lunch: { ...current.lunch, ...(patch.lunch ?? {}) },
    notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
    ai: { ...current.ai, ...(patch.ai ?? {}) },
  };
  // Switching away from the API revokes the billing consent.
  if (patch.ai?.provider && patch.ai.provider !== "anthropic_api") merged.ai.apiBillingConsentAt = null;
  const r = zSettings.safeParse(merged);
  if (!r.success) {
    throw new DomainError("validation", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  if (r.data.dayEnd <= r.data.dayStart) throw new DomainError("validation", "Your day must end after it starts.");
  if (r.data.weekendEnd <= r.data.weekendStart) throw new DomainError("validation", "Weekend hours must end after they start.");
  if (r.data.lunch.latest <= r.data.lunch.earliest) throw new DomainError("validation", "The lunch window must end after it starts.");
  return saveSettings(db, r.data);
}

/** Record (or revoke) explicit consent to separately billed Anthropic API usage. */
export function setApiConsent(db: Database, granted: boolean): Settings {
  const current = loadSettings(db);
  return saveSettings(db, {
    ...current,
    ai: {
      ...current.ai,
      provider: granted ? "anthropic_api" : current.ai.provider === "anthropic_api" ? "claude_code" : current.ai.provider,
      apiBillingConsentAt: granted ? new Date().toISOString() : null,
    },
  });
}
