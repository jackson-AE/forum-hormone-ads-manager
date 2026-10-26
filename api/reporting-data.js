const crypto = require("crypto");

const APPS_SCRIPT_URL = process.env.HORMONE_APPS_SCRIPT_URL || "";
const APPS_SCRIPT_SECRET = process.env.HORMONE_APPS_SCRIPT_SECRET || "";
const DASHBOARD_PASSWORD = process.env.HORMONE_DASHBOARD_PASSWORD || "";
const COOKIE_NAME = "fh_hormone_auth";

let lastGoodPayload = null;

function parseCookies(header) {
  return String(header || "").split(";").reduce((cookies, part) => {
    const index = part.indexOf("=");
    if (index > -1) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return cookies;
  }, {});
}

function signSession(timestamp) {
  return crypto.createHmac("sha256", DASHBOARD_PASSWORD).update(String(timestamp)).digest("hex");
}

function hasValidSession(req) {
  if (!DASHBOARD_PASSWORD) return false;
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME] || "";
  const [timestamp, signature] = token.split(".");
  if (!timestamp || !signature) return false;
  const ageMs = Date.now() - Number(timestamp);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 12 * 60 * 60 * 1000) return false;
  const expected = signSession(timestamp);
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function loadReportingData() {
  if (!APPS_SCRIPT_URL || !APPS_SCRIPT_SECRET) {
    throw new Error("Hormone Apps Script connection is not configured.");
  }

  const url = new URL(APPS_SCRIPT_URL);
  url.searchParams.set("key", APPS_SCRIPT_SECRET);
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { accept: "application/json" },
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch (error) { throw new Error("Apps Script returned a non-JSON response."); }

  if (!response.ok || payload.error) {
    throw new Error([payload.error, payload.detail].filter(Boolean).join(": ") || `Apps Script returned ${response.status}`);
  }

  lastGoodPayload = {
    rows: Array.isArray(payload.rows) ? payload.rows : [],
    dataUpdatedAt: payload.dataUpdatedAt || payload.updatedAt || new Date().toISOString(),
    stale: false,
    warning: "",
  };
  return lastGoodPayload;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!hasValidSession(req)) {
    res.status(401).json({ error: "Password required" });
    return;
  }

  try {
    const payload = await loadReportingData();
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(payload);
  } catch (error) {
    if (lastGoodPayload) {
      res.status(200).json({
        ...lastGoodPayload,
        stale: true,
        warning: `Using the last successful load because the sheet bridge failed: ${error.message || error}`,
      });
      return;
    }
    res.status(502).json({
      error: "Dashboard data could not be loaded.",
      detail: String(error && error.message ? error.message : error),
    });
  }
};
