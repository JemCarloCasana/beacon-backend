import express from "express";
import { pool } from "../db.js";
import { requireAdminAuth } from "../middleware/adminAuth.js";

const router = express.Router();

const SUPPORTED_TIMEZONE = "Asia/Manila";
const RANGE_TO_WINDOW_MS = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000
};
const INCIDENT_PRIORITY_BUCKETS = ["low", "medium", "high", "critical"];
const REPORT_DEFS = {
  daily_safety_report: {
    report_key: "daily_safety_report",
    range: "24h",
    title: "Daily Safety Report",
    description: "Combined incident and SOS overview for the last 24 hours"
  },
  weekly_safety_report: {
    report_key: "weekly_safety_report",
    range: "7d",
    title: "Weekly Safety Report",
    description: "Combined incident and SOS overview for the last 7 days"
  },
  monthly_safety_report: {
    report_key: "monthly_safety_report",
    range: "30d",
    title: "Monthly Safety Report",
    description: "Combined incident and SOS overview for the last 30 days"
  }
};
const CARD_ORDER = [
  REPORT_DEFS.daily_safety_report,
  REPORT_DEFS.weekly_safety_report,
  REPORT_DEFS.monthly_safety_report
];

function parseRange(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return Object.prototype.hasOwnProperty.call(RANGE_TO_WINDOW_MS, normalized) ? normalized : null;
}

function parseTimezone(value) {
  const timezone = typeof value === "string" && value.trim() ? value.trim() : SUPPORTED_TIMEZONE;
  return timezone === SUPPORTED_TIMEZONE ? timezone : null;
}

function parseReportKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  return Object.prototype.hasOwnProperty.call(REPORT_DEFS, key) ? key : null;
}

function toIso(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function toNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return num;
}

function toInt(value) {
  return Math.round(toNumber(value));
}

function formatSosCategoryLabel(value) {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "medical":
      return "Medical";
    case "fire":
      return "Fire";
    case "violence":
      return "Violence";
    case "unknown":
      return "Unknown";
    default:
      return value ?? "";
  }
}

function buildPriorityBuckets(rows) {
  const counts = new Map(INCIDENT_PRIORITY_BUCKETS.map((priority) => [priority, 0]));

  for (const row of rows) {
    const normalizedLabel = String(row?.label ?? "")
      .trim()
      .toLowerCase();
    if (!counts.has(normalizedLabel)) {
      continue;
    }
    counts.set(normalizedLabel, counts.get(normalizedLabel) + toInt(row?.value));
  }

  return INCIDENT_PRIORITY_BUCKETS.map((priority) => ({
    label: priority,
    value: counts.get(priority) ?? 0
  }));
}

function getGranularity(range) {
  return range === "24h" ? "hour" : "day";
}

function getWindowStart(range, now = new Date()) {
  return new Date(now.getTime() - RANGE_TO_WINDOW_MS[range]);
}

function shiftToManila(date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000);
}

function formatBucketKey(shiftedDate, granularity) {
  const year = shiftedDate.getUTCFullYear();
  const month = String(shiftedDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shiftedDate.getUTCDate()).padStart(2, "0");
  if (granularity === "hour") {
    const hour = String(shiftedDate.getUTCHours()).padStart(2, "0");
    return `${year}-${month}-${day} ${hour}:00`;
  }
  return `${year}-${month}-${day}`;
}

function floorShiftedDate(shiftedDate, granularity) {
  const floored = new Date(shiftedDate.getTime());
  floored.setUTCMinutes(0, 0, 0);
  if (granularity === "day") {
    floored.setUTCHours(0, 0, 0, 0);
  }
  return floored;
}

function generateBucketKeys({ start, end, granularity }) {
  const startShifted = floorShiftedDate(shiftToManila(start), granularity);
  const endShifted = floorShiftedDate(shiftToManila(end), granularity);
  const stepMs = granularity === "hour" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

  const keys = [];
  for (let cursor = startShifted.getTime(); cursor <= endShifted.getTime(); cursor += stepMs) {
    keys.push(formatBucketKey(new Date(cursor), granularity));
  }
  return keys;
}

function escapeCsv(value) {
  if (value == null) {
    return "";
  }
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function toCsv(rows) {
  return rows.map((row) => row.map((value) => escapeCsv(value)).join(",")).join("\n");
}

async function getCardsMetadata(timezone) {
  const result = await pool.query(
    `
    SELECT report_key, range_key, generated_at
    FROM (
      SELECT
        report_key,
        range_key,
        timezone,
        generated_at,
        ROW_NUMBER() OVER (
          PARTITION BY report_key, range_key, timezone
          ORDER BY generated_at DESC
        ) AS rn
      FROM admin_report_runs
      WHERE timezone = $1
    ) latest
    WHERE rn = 1
    `,
    [timezone]
  );

  const lastGeneratedMap = new Map();
  for (const row of result.rows) {
    const key = `${row.report_key}|${row.range_key}`;
    lastGeneratedMap.set(key, toIso(row.generated_at));
  }

  return CARD_ORDER.map((card) => ({
    ...card,
    last_generated_at: lastGeneratedMap.get(`${card.report_key}|${card.range}`) ?? null
  }));
}

async function buildAnalytics({ range, timezone, now = new Date() }) {
  const windowStart = getWindowStart(range, now);
  const granularity = getGranularity(range);
  const bucketExpr =
    granularity === "hour"
      ? "to_char(date_trunc('hour', created_at AT TIME ZONE 'Asia/Manila'), 'YYYY-MM-DD HH24:00')"
      : "to_char(date_trunc('day', created_at AT TIME ZONE 'Asia/Manila'), 'YYYY-MM-DD')";
  const sosTimeExpr = "COALESCE(le.created_at, root.created_at)";
  const sosBucketExpr =
    granularity === "hour"
      ? `to_char(date_trunc('hour', ${sosTimeExpr} AT TIME ZONE 'Asia/Manila'), 'YYYY-MM-DD HH24:00')`
      : `to_char(date_trunc('day', ${sosTimeExpr} AT TIME ZONE 'Asia/Manila'), 'YYYY-MM-DD')`;

  const kpiResult = await pool.query(
    `
    SELECT
      COUNT(*)::int AS total_incidents,
      COUNT(*) FILTER (WHERE status IN ('pending', 'dispatched', 'in_progress'))::int AS active_incidents,
      COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved_incidents,
      COALESCE(
        AVG(EXTRACT(EPOCH FROM (dispatched_at - created_at))) FILTER (WHERE dispatched_at IS NOT NULL),
        0
      ) AS avg_response_seconds,
      COALESCE(
        AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))) FILTER (WHERE resolved_at IS NOT NULL),
        0
      ) AS avg_resolution_seconds
    FROM incident_reports
    WHERE created_at >= $1
    `,
    [windowStart.toISOString()]
  );

  const activeSosResult = await pool.query(
    `
    SELECT COUNT(*)::int AS active_sos
    FROM sos_threads st
    LEFT JOIN sos_events root ON root.id = st.root_event_id
    LEFT JOIN LATERAL (
      SELECT e.created_at
      FROM sos_events e
      WHERE e.sos_id = st.root_event_id
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 1
    ) le ON TRUE
    WHERE st.latest_status = 'active'
      AND COALESCE(le.created_at, root.created_at) >= $1
    `,
    [windowStart.toISOString()]
  );

  const statusResult = await pool.query(
    `
    SELECT status AS label, COUNT(*)::int AS value
    FROM incident_reports
    WHERE created_at >= $1
    GROUP BY status
    ORDER BY
      CASE status
        WHEN 'pending' THEN 1
        WHEN 'dispatched' THEN 2
        WHEN 'in_progress' THEN 3
        WHEN 'resolved' THEN 4
        ELSE 99
      END
    `,
    [windowStart.toISOString()]
  );

  const priorityResult = await pool.query(
    `
    SELECT priority AS label, COUNT(*)::int AS value
    FROM incident_reports
    WHERE created_at >= $1
    GROUP BY priority
    ORDER BY
      CASE priority
        WHEN 'critical' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        WHEN 'low' THEN 4
        ELSE 99
      END
    `,
    [windowStart.toISOString()]
  );

  const incidentTrendResult = await pool.query(
    `
    SELECT ${bucketExpr} AS bucket_key, COUNT(*)::int AS incidents
    FROM incident_reports
    WHERE created_at >= $1
    GROUP BY bucket_key
    ORDER BY bucket_key
    `,
    [windowStart.toISOString()]
  );

  const sosTrendResult = await pool.query(
    `
    SELECT ${sosBucketExpr} AS bucket_key, COUNT(*)::int AS sos
    FROM sos_threads st
    LEFT JOIN sos_events root ON root.id = st.root_event_id
    LEFT JOIN LATERAL (
      SELECT e.created_at
      FROM sos_events e
      WHERE e.sos_id = st.root_event_id
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 1
    ) le ON TRUE
    WHERE COALESCE(le.created_at, root.created_at) >= $1
    GROUP BY bucket_key
    ORDER BY bucket_key
    `,
    [windowStart.toISOString()]
  );

  const responseTrendResult = await pool.query(
    `
    SELECT
      ${bucketExpr} AS bucket_key,
      COALESCE(
        AVG(EXTRACT(EPOCH FROM (dispatched_at - created_at))) FILTER (WHERE dispatched_at IS NOT NULL),
        0
      ) AS avg_response_seconds,
      COALESCE(
        AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))) FILTER (WHERE resolved_at IS NOT NULL),
        0
      ) AS avg_resolution_seconds
    FROM incident_reports
    WHERE created_at >= $1
    GROUP BY bucket_key
    ORDER BY bucket_key
    `,
    [windowStart.toISOString()]
  );

  const incidentCategoriesResult = await pool.query(
    `
    SELECT incident_type AS label, COUNT(*)::int AS value
    FROM incident_reports
    WHERE created_at >= $1
    GROUP BY incident_type
    ORDER BY COUNT(*) DESC, incident_type ASC
    `,
    [windowStart.toISOString()]
  );

  const sosCategoriesResult = await pool.query(
    `
    SELECT st.emergency_category AS label, COUNT(*)::int AS value
    FROM sos_threads st
    WHERE st.created_at >= $1
    GROUP BY st.emergency_category
    ORDER BY COUNT(*) DESC, st.emergency_category ASC
    `,
    [windowStart.toISOString()]
  );

  const bucketKeys = generateBucketKeys({ start: windowStart, end: now, granularity });
  const incidentBucketMap = new Map(
    incidentTrendResult.rows.map((row) => [String(row.bucket_key), toInt(row.incidents)])
  );
  const sosBucketMap = new Map(sosTrendResult.rows.map((row) => [String(row.bucket_key), toInt(row.sos)]));
  const responseBucketMap = new Map(
    responseTrendResult.rows.map((row) => [
      String(row.bucket_key),
      {
        avg_response_seconds: toInt(row.avg_response_seconds),
        avg_resolution_seconds: toInt(row.avg_resolution_seconds)
      }
    ])
  );

  return {
    generated_at: now.toISOString(),
    range,
    timezone,
    kpis: {
      total_incidents: toInt(kpiResult.rows[0]?.total_incidents),
      active_incidents: toInt(kpiResult.rows[0]?.active_incidents),
      resolved_incidents: toInt(kpiResult.rows[0]?.resolved_incidents),
      active_sos: toInt(activeSosResult.rows[0]?.active_sos),
      avg_response_seconds: toInt(kpiResult.rows[0]?.avg_response_seconds),
      avg_resolution_seconds: toInt(kpiResult.rows[0]?.avg_resolution_seconds)
    },
    charts: {
      incidents_by_status: statusResult.rows.map((row) => ({
        label: row.label,
        value: toInt(row.value)
      })),
      incidents_by_priority: buildPriorityBuckets(priorityResult.rows),
      incidents_trend: bucketKeys.map((bucketKey) => ({
        bucket: bucketKey,
        incidents: incidentBucketMap.get(bucketKey) ?? 0,
        sos: sosBucketMap.get(bucketKey) ?? 0
      })),
      response_time_trend: bucketKeys.map((bucketKey) => {
        const value = responseBucketMap.get(bucketKey);
        return {
          bucket: bucketKey,
          avg_response_seconds: value?.avg_response_seconds ?? 0,
          avg_resolution_seconds: value?.avg_resolution_seconds ?? 0
        };
      }),
      incident_categories_frequency: incidentCategoriesResult.rows.map((row) => ({
        label: row.label,
        value: toInt(row.value)
      })),
      sos_categories_frequency: sosCategoriesResult.rows.map((row) => ({
        label: formatSosCategoryLabel(row.label),
        value: toInt(row.value)
      }))
    }
  };
}

async function getCsvDetails({ range, now = new Date() }) {
  const windowStart = getWindowStart(range, now);
  const incidentResult = await pool.query(
    `
    SELECT
      id,
      incident_type,
      status,
      priority,
      assigned_department,
      address,
      created_at,
      dispatched_at,
      resolved_at
    FROM incident_reports
    WHERE created_at >= $1
    ORDER BY created_at DESC, id DESC
    `,
    [windowStart.toISOString()]
  );

  const sosResult = await pool.query(
    `
    SELECT
      st.root_event_id AS sos_id,
      st.latest_status,
      st.emergency_category,
      st.assigned_unit,
      st.terminal_status,
      root.address,
      root.created_at AS opened_at,
      st.resolved_at
    FROM sos_threads st
    LEFT JOIN sos_events root ON root.id = st.root_event_id
    WHERE st.created_at >= $1
    ORDER BY st.created_at DESC, st.root_event_id DESC
    `,
    [windowStart.toISOString()]
  );

  return {
    incidents: incidentResult.rows.map((row) => ({
      id: row.id,
      incident_type: row.incident_type ?? "",
      status: row.status ?? "",
      priority: row.priority ?? "",
      assigned_department: row.assigned_department ?? "",
      address: row.address ?? "",
      created_at: toIso(row.created_at) ?? "",
      dispatched_at: toIso(row.dispatched_at) ?? "",
      resolved_at: toIso(row.resolved_at) ?? ""
    })),
    sos: sosResult.rows.map((row) => ({
      sos_id: row.sos_id,
      latest_status: row.latest_status ?? "",
      emergency_category: formatSosCategoryLabel(row.emergency_category),
      assigned_unit: row.assigned_unit ?? "",
      terminal_status: row.terminal_status ?? "",
      address: row.address ?? "",
      opened_at: toIso(row.opened_at) ?? "",
      resolved_at: toIso(row.resolved_at) ?? ""
    }))
  };
}

function buildCsvPayload(reportPayload, details) {
  const { generated_at, range, timezone, kpis, charts } = reportPayload;
  const responseTrendMap = new Map(
    charts.response_time_trend.map((row) => [
      row.bucket,
      {
        avg_response_seconds: row.avg_response_seconds,
        avg_resolution_seconds: row.avg_resolution_seconds
      }
    ])
  );

  const rows = [
    ["Metadata"],
    ["range", range],
    ["timezone", timezone],
    ["generated_at", generated_at],
    [],
    ["KPIs"],
    ["total_incidents", kpis.total_incidents],
    ["active_incidents", kpis.active_incidents],
    ["resolved_incidents", kpis.resolved_incidents],
    ["active_sos", kpis.active_sos],
    ["avg_response_seconds", kpis.avg_response_seconds],
    ["avg_resolution_seconds", kpis.avg_resolution_seconds],
    [],
    ["Incident Status Distribution"],
    ["label", "value"],
    ...charts.incidents_by_status.map((row) => [row.label, row.value]),
    [],
    ["Incident Priority Distribution"],
    ["label", "value"],
    ...charts.incidents_by_priority.map((row) => [row.label, row.value]),
    [],
    ["Incident Category Frequency"],
    ["label", "value"],
    ...charts.incident_categories_frequency.map((row) => [row.label, row.value]),
    [],
    ["SOS Category Frequency"],
    ["label", "value"],
    ...charts.sos_categories_frequency.map((row) => [row.label, row.value]),
    [],
    ["Trend Rows"],
    ["bucket", "incidents", "sos", "avg_response_seconds", "avg_resolution_seconds"],
    ...charts.incidents_trend.map((row) => {
      const response = responseTrendMap.get(row.bucket) ?? {
        avg_response_seconds: 0,
        avg_resolution_seconds: 0
      };
      return [
        row.bucket,
        row.incidents,
        row.sos,
        response.avg_response_seconds,
        response.avg_resolution_seconds
      ];
    }),
    [],
    ["Incident Details"],
    [
      "incident_id",
      "incident_type",
      "status",
      "priority",
      "assigned_department",
      "address",
      "created_at",
      "dispatched_at",
      "resolved_at"
    ],
    ...details.incidents.map((row) => [
      row.id,
      row.incident_type,
      row.status,
      row.priority,
      row.assigned_department,
      row.address,
      row.created_at,
      row.dispatched_at,
      row.resolved_at
    ]),
    [],
    ["SOS Details"],
    [
      "sos_id",
      "latest_status",
      "emergency_category",
      "assigned_unit",
      "terminal_status",
      "address",
      "opened_at",
      "resolved_at"
    ],
    ...details.sos.map((row) => [
      row.sos_id,
      row.latest_status,
      row.emergency_category,
      row.assigned_unit,
      row.terminal_status,
      row.address,
      row.opened_at,
      row.resolved_at
    ])
  ];

  return `${toCsv(rows)}\n`;
}

router.get("/admin/reports/overview", requireAdminAuth, async (req, res) => {
  try {
    const range = parseRange(req.query?.range);
    if (!range) {
      return res.status(400).json({ message: "Invalid range" });
    }

    const timezone = parseTimezone(req.query?.timezone);
    if (!timezone) {
      return res.status(400).json({ message: "Invalid timezone" });
    }

    const analytics = await buildAnalytics({ range, timezone });
    const cards = await getCardsMetadata(timezone);

    return res.json({
      generated_at: analytics.generated_at,
      range: analytics.range,
      timezone: analytics.timezone,
      cards,
      kpis: analytics.kpis,
      charts: analytics.charts
    });
  } catch (err) {
    console.error("GET /admin/reports/overview error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/admin/reports/generate", requireAdminAuth, async (req, res) => {
  try {
    const reportKey = parseReportKey(req.body?.report_key);
    if (!reportKey) {
      return res.status(400).json({ message: "Invalid report_key" });
    }

    const timezone = parseTimezone(req.body?.timezone);
    if (!timezone) {
      return res.status(400).json({ message: "Invalid timezone" });
    }

    const range = REPORT_DEFS[reportKey].range;
    const generatedAt = new Date();
    const analytics = await buildAnalytics({ range, timezone, now: generatedAt });

    const adminId = Number(req.admin?.adminId);
    await pool.query(
      `
      INSERT INTO admin_report_runs (
        report_key,
        range_key,
        timezone,
        generated_by_admin_id,
        generated_at,
        payload_hash
      ) VALUES ($1, $2, $3, $4, $5, NULL)
      `,
      [reportKey, range, timezone, Number.isInteger(adminId) ? adminId : null, generatedAt.toISOString()]
    );

    const cards = await getCardsMetadata(timezone);
    return res.json({
      generated_at: analytics.generated_at,
      range: analytics.range,
      timezone: analytics.timezone,
      cards,
      kpis: analytics.kpis,
      charts: analytics.charts
    });
  } catch (err) {
    console.error("POST /admin/reports/generate error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/admin/reports/export.csv", requireAdminAuth, async (req, res) => {
  try {
    const range = parseRange(req.query?.range);
    if (!range) {
      return res.status(400).json({ message: "Invalid range" });
    }

    const timezone = parseTimezone(req.query?.timezone);
    if (!timezone) {
      return res.status(400).json({ message: "Invalid timezone" });
    }

    const analytics = await buildAnalytics({ range, timezone });
    const filenameTimestamp = analytics.generated_at.replace(/[:.]/g, "-");
    const details = await getCsvDetails({ range, now: new Date(analytics.generated_at) });
    const csv = buildCsvPayload(analytics, details);

    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set(
      "Content-Disposition",
      `attachment; filename="beacon-report-${range}-${filenameTimestamp}.csv"`
    );
    return res.send(csv);
  } catch (err) {
    console.error("GET /admin/reports/export.csv error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;
