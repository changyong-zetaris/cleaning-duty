// Cleaning Duty Auto-Assignment Script
// Runs via GitHub Actions on Monday and Thursday
// Reads/writes Firestore, sends Teams webhook notification

const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const TEAMS_WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL;
const GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME;

const MELBOURNE_TIMEZONE = "Australia/Melbourne";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

async function readDoc(path) {
  const url = `${FIRESTORE_BASE}/${path}?key=${FIREBASE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error("Firestore read error:", await res.text());
    return null;
  }
  const doc = await res.json();
  return fromFirestore(doc.fields);
}

async function writeDoc(path, data) {
  const url = `${FIRESTORE_BASE}/${path}?key=${FIREBASE_API_KEY}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: toFirestore(data) }),
  });
  if (!res.ok) {
    console.error("Firestore write error:", await res.text());
    return false;
  }
  return true;
}

function fromFirestore(fields) {
  if (!fields) return null;
  const result = {};
  for (const key in fields) {
    result[key] = fromValue(fields[key]);
  }
  return result;
}

function fromValue(v) {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.arrayValue) return (v.arrayValue.values || []).map(fromValue);
  if (v.mapValue) return fromFirestore(v.mapValue.fields);
  return null;
}

function toFirestore(obj) {
  const fields = {};
  for (const key in obj) {
    fields[key] = toValue(obj[key]);
  }
  return fields;
}

function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: v.toString() } : { doubleValue: v };
  }
  if (typeof v === "boolean") return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === "object") return { mapValue: { fields: toFirestore(v) } };
  return { stringValue: String(v) };
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function unique(items) {
  return [...new Set(items)];
}

function getMelbourneDateString() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MELBOURNE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function parseDateString(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return { year, month, day };
}

function addDays(dateString, days) {
  const { year, month, day } = parseDateString(dateString);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  utcDate.setUTCDate(utcDate.getUTCDate() + days);
  return `${utcDate.getUTCFullYear()}-${String(utcDate.getUTCMonth() + 1).padStart(2, "0")}-${String(utcDate.getUTCDate()).padStart(2, "0")}`;
}

function getDayOfWeek(dateString) {
  const { year, month, day } = parseDateString(dateString);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function normalizeMembers(members) {
  if (!Array.isArray(members)) return [];
  return members
    .map((member) => {
      if (typeof member === "string") {
        const name = member.trim();
        return name ? { name, email: "" } : null;
      }

      const name = String(member?.name || "").trim();
      if (!name) return null;
      return {
        ...member,
        name,
        email: typeof member?.email === "string" ? member.email : "",
      };
    })
    .filter(Boolean)
    .filter((member, index, arr) => arr.findIndex((entry) => entry.name === member.name) === index);
}

function normalizeHolidayOverrides(holidayOverrides) {
  const additions = Array.isArray(holidayOverrides?.additions)
    ? holidayOverrides.additions
        .map((holiday) => ({
          date: String(holiday?.date || ""),
          name: String(holiday?.name || "").trim(),
        }))
        .filter((holiday) => /^\d{4}-\d{2}-\d{2}$/.test(holiday.date) && holiday.name)
        .filter((holiday, index, arr) => arr.findIndex((entry) => entry.date === holiday.date) === index)
    : [];

  const exclusions = Array.isArray(holidayOverrides?.exclusions)
    ? unique(
        holidayOverrides.exclusions
          .map((date) => String(date || "").trim())
          .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
      )
    : [];

  return { additions, exclusions };
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.map((entry, index) => ({
    ...entry,
    id: entry?.id || `legacy-${index}-${entry?.date || "unknown"}`,
    assigned: Array.isArray(entry?.assigned) ? entry.assigned.filter(Boolean) : [],
    date: entry?.date || "",
    scheduledFor: entry?.scheduledFor || entry?.date || "",
    advancedForHoliday: Boolean(entry?.advancedForHoliday),
    holidayName: entry?.holidayName || "",
    holidayDate: entry?.holidayDate || "",
    carriedOver: Array.isArray(entry?.carriedOver) ? entry.carriedOver.filter(Boolean) : [],
    cycle: Number(entry?.cycle || 0),
    round: Number(entry?.round || 0),
  }));
}

function reconcileStateWithMembers(state, memberNames) {
  const history = normalizeHistory(state?.history);
  const cycle = Number(state?.cycle || 0);
  const currentCycleAssigned = new Set(
    history
      .filter((entry) => entry.cycle === cycle)
      .flatMap((entry) => entry.assigned)
      .filter((name) => memberNames.includes(name))
  );

  const remaining = unique(
    Array.isArray(state?.remaining)
      ? state.remaining.filter((name) => memberNames.includes(name))
      : []
  ).filter((name) => !currentCycleAssigned.has(name));

  const missing = memberNames.filter((name) => !currentCycleAssigned.has(name) && !remaining.includes(name));
  const nextRemaining = [...remaining, ...shuffle(missing)];

  // Carried-over candidates are members whose duty is still pending from an
  // earlier cycle. They only stay pending while they are still in the rotation.
  const carryOver = unique(
    Array.isArray(state?.carryOver) ? state.carryOver.filter((name) => memberNames.includes(name)) : []
  ).filter((name) => nextRemaining.includes(name));

  return {
    cycle,
    history,
    remaining: nextRemaining,
    carryOver,
  };
}

/**
 * Draws the members for one round.
 *
 * A cycle ends when it can no longer fill a full round. Members the cycle never
 * reached are carried over instead of being dropped, and carried-over members are
 * always drawn first in the new cycle, so nobody is reset out of the rotation
 * before they have actually done their duty.
 */
function drawPicks(state, memberNames, pickCount) {
  let cycle = Number(state?.cycle || 0);
  let remaining = [...(state?.remaining || [])];
  let carryOver = [...(state?.carryOver || [])];

  if (remaining.length < pickCount) {
    carryOver = unique([...carryOver, ...remaining]);
    cycle += 1;
    remaining = shuffle(memberNames);
  }

  const picks = [];
  const carriedPicks = [];

  while (picks.length < pickCount && carryOver.length > 0) {
    const name = carryOver.shift();
    picks.push(name);
    carriedPicks.push(name);
    remaining = remaining.filter((entry) => entry !== name);
  }

  while (picks.length < pickCount && remaining.length > 0) {
    const index = Math.floor(Math.random() * remaining.length);
    picks.push(remaining.splice(index, 1)[0]);
  }

  return { cycle, remaining, carryOver, picks, carriedPicks };
}

async function fetchMelbournePublicHolidays(years, holidayOverrides) {
  const overrides = normalizeHolidayOverrides(holidayOverrides);
  const responses = await Promise.all(
    unique(years).map(async (year) => {
      const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/AU`;
      try {
        const res = await fetch(url);
        if (!res.ok) {
          console.warn(`Holiday API unavailable for ${year}: ${res.status}`);
          return [];
        }

        const holidays = await res.json();
        return holidays
          .filter((holiday) => holiday.counties === null || holiday.counties.includes("AU-VIC"))
          .map((holiday) => ({
            date: holiday.date,
            name: holiday.localName || holiday.name,
          }));
      } catch (error) {
        console.warn(`Failed to fetch holiday data for ${year}:`, error.message);
        return [];
      }
    })
  );

  const holidayMap = new Map();

  responses.flat().forEach((holiday) => {
    if (overrides.exclusions.includes(holiday.date)) return;
    holidayMap.set(holiday.date, { ...holiday });
  });

  overrides.additions.forEach((holiday) => {
    holidayMap.set(holiday.date, { ...holiday });
  });

  return holidayMap;
}

function getRunContext(today, holidayMap) {
  if (GITHUB_EVENT_NAME === "workflow_dispatch") {
    return {
      shouldRun: true,
      date: today,
      scheduledFor: today,
      advancedForHoliday: false,
      holidayName: "",
      holidayDate: "",
      reason: "Manual workflow dispatch",
    };
  }

  const dayOfWeek = getDayOfWeek(today);

  if (dayOfWeek === 1) {
    if (holidayMap.has(today)) {
      const holiday = holidayMap.get(today);
      return {
        shouldRun: false,
        reason: `Skipping: today (${today}) is a public holiday - ${holiday.name}`,
      };
    }

    return {
      shouldRun: true,
      date: today,
      scheduledFor: today,
      advancedForHoliday: false,
      holidayName: "",
      holidayDate: "",
      reason: "Regular Monday run",
    };
  }

  if (dayOfWeek === 4) {
    if (holidayMap.has(today)) {
      const holiday = holidayMap.get(today);
      return {
        shouldRun: false,
        reason: `Skipping: today (${today}) is a public holiday - ${holiday.name}`,
      };
    }

    const nextMonday = addDays(today, 4);
    const mondayHoliday = holidayMap.get(nextMonday);
    if (!mondayHoliday) {
      return {
        shouldRun: false,
        reason: `Skipping: next Monday (${nextMonday}) is not a holiday, so the regular Monday run will handle it.`,
      };
    }

    return {
      shouldRun: true,
      date: today,
      scheduledFor: nextMonday,
      advancedForHoliday: true,
      holidayName: mondayHoliday.name,
      holidayDate: nextMonday,
      reason: `Running early because next Monday (${nextMonday}) is ${mondayHoliday.name}`,
    };
  }

  return {
    shouldRun: false,
    reason: `Skipping: today (${today}) is not a scheduled run day.`,
  };
}

async function sendTeamsNotification(pick1, pick2, cycle, round, runContext, carriedPicks = []) {
  const scheduleNote = runContext.advancedForHoliday
    ? `Drawn early on ${runContext.date} because ${runContext.holidayDate} is ${runContext.holidayName}.`
    : "Auto-assigned on the regular schedule.";

  const carryNote = carriedPicks.length > 0
    ? ` ${carriedPicks.join(", ")} carried over from the previous cycle and ${carriedPicks.length === 1 ? "was" : "were"} drawn first.`
    : "";

  const note = `${scheduleNote}${carryNote}`;

  const cycleLine = runContext.advancedForHoliday
    ? `Cycle #${cycle} - Round ${round} (Scheduled for ${runContext.scheduledFor})`
    : `Cycle #${cycle} - Round ${round} (Auto-assigned)`;

  const card = {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        body: [
          { type: "TextBlock", size: "Large", weight: "Bolder", text: "Cleaning Roulette Result" },
          { type: "TextBlock", text: runContext.date, spacing: "Small" },
          {
            type: "ColumnSet",
            columns: [
              {
                type: "Column",
                width: "stretch",
                items: [
                  { type: "TextBlock", text: "Victim #1", weight: "Bolder", color: "Attention" },
                  { type: "TextBlock", text: pick1, size: "Large", weight: "Bolder" },
                  { type: "TextBlock", text: "Task: Red Bin", isSubtle: true, spacing: "Small" },
                ],
              },
              {
                type: "Column",
                width: "stretch",
                items: [
                  { type: "TextBlock", text: "Victim #2", weight: "Bolder", color: "Attention" },
                  { type: "TextBlock", text: pick2, size: "Large", weight: "Bolder" },
                  { type: "TextBlock", text: "Task: Yellow Bin", isSubtle: true, spacing: "Small" },
                ],
              },
            ],
          },
          { type: "TextBlock", text: cycleLine, isSubtle: true, spacing: "Medium" },
          { type: "TextBlock", text: note, wrap: true, spacing: "Small" },
        ],
      },
    }],
  };

  const res = await fetch(TEAMS_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card),
  });

  if (!res.ok) {
    console.error("Teams webhook error:", await res.text());
  }
}

function createHistoryId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main() {
  const today = getMelbourneDateString();

  const config = await readDoc("cleaning/config");
  if (!config || !config.members) {
    console.error("Config not found or missing members");
    process.exit(1);
  }

  const members = normalizeMembers(config.members);
  const memberNames = members.map((member) => member.name);
  if (memberNames.length < 2) {
    console.error("Need at least two members to run assignment");
    process.exit(1);
  }

  const holidayMap = await fetchMelbournePublicHolidays(
    [Number(today.slice(0, 4)), Number(addDays(today, 4).slice(0, 4))],
    config.holidayOverrides
  );
  const runContext = getRunContext(today, holidayMap);

  if (!runContext.shouldRun) {
    console.log(runContext.reason);
    return;
  }

  let state = await readDoc("cleaning/state");
  if (!state) {
    state = { remaining: [], cycle: 0, history: [], carryOver: [] };
  }

  state = reconcileStateWithMembers(state, memberNames);

  const draw = drawPicks(state, memberNames, 2);
  const [pick1, pick2] = draw.picks;
  const roundNum = state.history.filter((entry) => entry.cycle === draw.cycle).length + 1;

  state.cycle = draw.cycle;
  state.remaining = draw.remaining;
  state.carryOver = draw.carryOver;

  state.history.push({
    id: createHistoryId(),
    cycle: state.cycle,
    round: roundNum,
    assigned: [pick1, pick2],
    date: runContext.date,
    scheduledFor: runContext.scheduledFor,
    advancedForHoliday: runContext.advancedForHoliday,
    holidayName: runContext.holidayName,
    holidayDate: runContext.holidayDate,
    carriedOver: draw.carriedPicks,
  });

  const saved = await writeDoc("cleaning/state", state);
  if (!saved) {
    console.error("Failed to save state");
    process.exit(1);
  }

  await sendTeamsNotification(pick1, pick2, state.cycle, roundNum, runContext, draw.carriedPicks);
  if (draw.carriedPicks.length > 0) {
    console.log(`Carried over from the previous cycle: ${draw.carriedPicks.join(", ")}`);
  }
  console.log(`Assigned: ${pick1} & ${pick2} (Cycle #${state.cycle}, Round ${roundNum})`);
  console.log(runContext.reason);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
