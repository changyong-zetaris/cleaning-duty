// Cleaning Duty Auto-Assignment Script
// Runs via GitHub Actions every Monday at 11:00 AM
// Reads/writes Firestore, sends Teams webhook notification

const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const TEAMS_WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL;

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

// --- Firestore REST API ---

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

// --- Firestore format converters ---

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
  if (v.integerValue !== undefined) return parseInt(v.integerValue);
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

// --- Shuffle ---

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --- Teams notification ---

async function sendTeamsNotification(pick1, pick2, cycle, round, dateStr) {
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
          { type: "TextBlock", text: dateStr, spacing: "Small" },
          {
            type: "ColumnSet",
            columns: [
              {
                type: "Column", width: "stretch",
                items: [
                  { type: "TextBlock", text: "Victim #1", weight: "Bolder", color: "Attention" },
                  { type: "TextBlock", text: pick1, size: "Large", weight: "Bolder" },
                ],
              },
              {
                type: "Column", width: "stretch",
                items: [
                  { type: "TextBlock", text: "Victim #2", weight: "Bolder", color: "Attention" },
                  { type: "TextBlock", text: pick2, size: "Large", weight: "Bolder" },
                ],
              },
            ],
          },
          { type: "TextBlock", text: `Cycle #${cycle} - Round ${round} (Auto-assigned)`, isSubtle: true, spacing: "Medium" },
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

// --- Melbourne public holiday check ---

async function isMelbournePublicHoliday() {
  // Get today's date in Melbourne timezone
  const melbourneDate = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
  const year = melbourneDate.split("-")[0];

  const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/AU`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn("Holiday API unavailable, proceeding with assignment");
    return false;
  }

  const holidays = await res.json();
  // Include national holidays (counties === null) and Victoria holidays
  const isHoliday = holidays.some(
    (h) => h.date === melbourneDate && (h.counties === null || h.counties.includes("AU-VIC"))
  );

  if (isHoliday) {
    const match = holidays.find(
      (h) => h.date === melbourneDate && (h.counties === null || h.counties.includes("AU-VIC"))
    );
    console.log(`Skipping: today (${melbourneDate}) is a public holiday — ${match.localName}`);
  }

  return isHoliday;
}

// --- Main ---

async function main() {
  // Skip assignment on Melbourne public holidays
  if (await isMelbournePublicHoliday()) {
    return;
  }

  // Read config (members list)
  const config = await readDoc("cleaning/config");
  if (!config || !config.members) {
    console.error("Config not found or missing members");
    process.exit(1);
  }

  const memberNames = config.members.map((m) => m.name);

  // Read current state
  let state = await readDoc("cleaning/state");
  if (!state) {
    state = { remaining: [], cycle: 0, history: [] };
  }

  // Start new cycle if needed
  if (!state.remaining || state.remaining.length < 2) {
    state.cycle = (state.cycle || 0) + 1;
    state.remaining = shuffle([...memberNames]);
  }

  // Pick 2 random people
  const idx1 = Math.floor(Math.random() * state.remaining.length);
  const pick1 = state.remaining.splice(idx1, 1)[0];
  const idx2 = Math.floor(Math.random() * state.remaining.length);
  const pick2 = state.remaining.splice(idx2, 1)[0];

  const roundNum = (memberNames.length - state.remaining.length) / 2;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });

  if (!state.history) state.history = [];
  state.history.push({
    cycle: state.cycle,
    round: roundNum,
    assigned: [pick1, pick2],
    date: today,
  });

  // Save to Firestore
  const saved = await writeDoc("cleaning/state", state);
  if (!saved) {
    console.error("Failed to save state");
    process.exit(1);
  }

  // Notify Teams
  await sendTeamsNotification(pick1, pick2, state.cycle, roundNum, today);

  console.log(`Assigned: ${pick1} & ${pick2} (Cycle #${state.cycle}, Round ${roundNum})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
