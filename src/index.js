import { DateTime } from "luxon";
import ical from "ical-generator";

const ZONE = "America/Chicago"; // Omaha

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/upload" && request.method === "GET") {
      return htmlPage(uploadForm());
    }
    if (url.pathname === "/upload" && request.method === "POST") {
      return handleUpload(request, env);
    }
    if (env.FEED_SECRET && url.pathname === `/feed/${env.FEED_SECRET}.ics` && request.method === "GET") {
		return handleFeed(request, env);
	}
    return new Response("Not found", { status: 404 });
  },
};

// ---------- Upload ----------

async function handleUpload(request, env) {
  let list;
  try {
    const form = await request.formData();
    const pasted = form.get("json");
    const file = form.get("file");
    let text = "";
    if (typeof pasted === "string" && pasted.trim()) {
      text = pasted;
    } else if (file && typeof file !== "string") {
      text = await file.text();
    }
    if (!text.trim()) {
      return htmlPage(uploadForm("Paste the JSON or choose a file first."), 400);
    }
    const data = JSON.parse(text);
    list = Array.isArray(data) ? data : data.regularShifts;
  } catch (e) {
    return htmlPage(uploadForm("That isn't valid JSON. Check that you copied the whole response body."), 400);
  }
  if (!Array.isArray(list)) {
    return htmlPage(uploadForm("No regularShifts list found in that JSON."), 400);
  }

  const all = list.map(normalize).filter(Boolean);
  if (all.length === 0) {
    return htmlPage(uploadForm("No shifts found in that JSON."), 400);
  }

  // Load current roster and keep a copy of it as a backup
  const stored = (await env.ROSTER_KV.get("roster", "json")) ?? {};
  const before = JSON.stringify(stored);
  if (before !== "{}") {
    await env.ROSTER_KV.put("roster_prev", before);
  }

  // Date range covered by this upload (includes deleted shifts)
  const times = all.map((s) => Date.parse(s.record.start));
  const lo = Math.min(...times);
  const hi = Math.max(...times);

  const live = all.filter((s) => !s.deleted);
  const liveIds = new Set(live.map((s) => s.record.id));

  let added = 0, updated = 0, removed = 0;

  // Remove shifts in this range that are gone or deleted
  for (const [id, s] of Object.entries(stored)) {
    const t = Date.parse(s.start);
    if (!liveIds.has(id) && t >= lo && t <= hi) {
      delete stored[id];
      removed++;
    }
  }

  // Add or update
  for (const { record } of live) {
    const old = stored[record.id];
    if (!old) added++;
    else if (JSON.stringify(old) !== JSON.stringify(record)) updated++;
    stored[record.id] = record;
  }

  await env.ROSTER_KV.put("roster", JSON.stringify(stored));

  const summary = `Added ${added}, updated ${updated}, removed ${removed}. Total shifts: ${Object.keys(stored).length}.`;
  return htmlPage(uploadForm(summary));
}

function normalize(raw) {
  if (!raw || raw.id == null || !raw.startDateTime || !raw.endDateTime) return null;
  const qualifier = raw.segments?.[0]?.orgJobRef?.qualifier ?? "";
  const title = qualifier.split("/")[1] || "Shift";
  return {
    deleted: raw.deleted === true,
    record: {
      id: String(raw.id),
      start: toUtcIso(raw.startDateTime),
      end: toUtcIso(raw.endDateTime),
      title,
    },
  };
}

// Omaha local time -> UTC ISO string. Luxon applies the daylight saving rules.
function toUtcIso(localStr) {
  const dt = DateTime.fromISO(localStr, { zone: ZONE });
  if (!dt.isValid) throw new Error(`Bad date: ${localStr} (${dt.invalidReason})`);
  return dt.toUTC().toISO();
}

// ---------- Feed ----------

async function handleFeed(request, env) {
  const rosterText = (await env.ROSTER_KV.get("roster")) ?? "{}";
  const etag = await makeEtag(rosterText);

  // Compare ignoring quotes and any weak "W/" prefix, since some clients alter them
  const clean = (v) => (v ?? "").replace(/^W\//, "").replace(/"/g, "");
  if (clean(request.headers.get("If-None-Match")) === clean(etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const stored = JSON.parse(rosterText);
  const shifts = Object.values(stored).sort((a, b) => a.start.localeCompare(b.start));

  const cal = ical({
    name: "Work",
    prodId: { company: "my-shifts", product: "roster" },
    domain: "my-shifts",
  });

  for (const s of shifts) {
    cal.createEvent({
      id: s.id,
      start: new Date(s.start),
      end: new Date(s.end),
      summary: s.title,
    });
  }

  return new Response(cal.toString(), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "ETag": etag,
      "Cache-Control": "private, max-age=300",
    },
  });
}

async function makeEtag(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex.slice(0, 32)}"`;
}

// ---------- HTML ----------

function uploadForm(message = "") {
  return `
    <h1>Upload roster</h1>
    ${message ? `<p><strong>${escHtml(message)}</strong></p>` : ""}
    <form method="POST" action="/upload" enctype="multipart/form-data">
      <p>Paste the roster JSON here:</p>
      <textarea name="json" rows="10" style="width:100%;font-family:monospace;font-size:14px" placeholder='{"regularShifts": [ ... ]}'></textarea>
      <p>Or choose a file instead:</p>
      <input type="file" name="file" accept=".json,application/json">
      <br><br>
      <button type="submit" style="font-size:18px;padding:10px 20px">Upload roster</button>
    </form>`;
}

function htmlPage(body, status = 200) {
  return new Response(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>My Shifts</title></head><body style="font-family:-apple-system,sans-serif;padding:20px">${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}