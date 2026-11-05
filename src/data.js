'use strict';
// Data layer for the Mathwhiz MCP server.
//
// Two adapters produce the same normalized dataset:
//   - "supabase": live reads from the platform's Supabase project via PostgREST
//     using the service key (server-side only, bypasses RLS; read-only usage).
//   - "snapshot": a local JSON fixture, used only for offline verification.
//
// Normalized dataset:
//   cohorts:           [{ id, name, grade (7-11|null), dayPair, capacity }]
//                      dayPair: 'monday_wednesday' | 'tuesday_thursday' | 'sunday' | null
//   activeEnrollments: [{ studentId, cohortId }]  (enrollment Active AND student Active)
//   studentsById:      { id: { grade (7-11|null) } }  (all students, any status)
//   guardians:         [{ id, phone }]
//   guardianStudents:  [{ guardianId, studentId }]
//   protectedIds:      Set of student ids fenced out (finance-protected), matching
//                      the platform assistant API's existing fence.

const fs = require('fs');

function gradeFromCode(code) {
  if (!code) return null;
  const m = /^G(\d{1,2})$/i.exec(String(code).trim());
  return m ? parseInt(m[1], 10) : null;
}

function gradeFromName(name) {
  if (!name) return null;
  const m = /Grade\s+(\d{1,2})/i.exec(name);
  return m ? parseInt(m[1], 10) : null;
}

function dayPairFromPattern(pattern) {
  if (!pattern) return null;
  const p = String(pattern);
  if (/mon\s*\/\s*wed/i.test(p)) return 'monday_wednesday';
  if (/tue\s*\/\s*thu/i.test(p)) return 'tuesday_thursday';
  if (/sunday/i.test(p)) return 'sunday';
  return null;
}

// ---------------------------------------------------------------------------
// Supabase (PostgREST) adapter
// ---------------------------------------------------------------------------

async function fetchAll(baseUrl, serviceKey, path) {
  const rows = [];
  const pageSize = 1000;
  let offset = 0;
  for (;;) {
    const url = `${baseUrl}/rest/v1/${path}`;
    const res = await fetch(url, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Range: `${offset}-${offset + pageSize - 1}`,
        'Range-Unit': 'items',
        Prefer: 'count=none',
      },
    });
    if (!res.ok) {
      throw new Error(`Supabase read failed (${path}): HTTP ${res.status}`);
    }
    const page = await res.json();
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

async function loadFromSupabase() {
  const baseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || '';
  if (!baseUrl || !serviceKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
  }

  const [cohortRows, programRows, pglRows, gradeRows, enrollmentRows,
    studentRows, guardianRows, relRows, protectedRows] = await Promise.all([
    fetchAll(baseUrl, serviceKey, 'cohorts?select=id,name,schedule_pattern,capacity,status,program_id&status=eq.Active'),
    fetchAll(baseUrl, serviceKey, 'programs?select=id,campus_id'),
    fetchAll(baseUrl, serviceKey, 'program_grade_levels?select=program_id,grade_level_id'),
    fetchAll(baseUrl, serviceKey, 'grade_levels?select=id,code,campus_id'),
    fetchAll(baseUrl, serviceKey, 'enrollments?select=student_id,cohort_id&status=eq.Active'),
    fetchAll(baseUrl, serviceKey, 'students?select=id,status,grade_level_id'),
    fetchAll(baseUrl, serviceKey, 'guardians?select=id,phone&archived_at=is.null'),
    fetchAll(baseUrl, serviceKey, 'guardian_student_relationships?select=guardian_id,student_id&revoked_at=is.null'),
    fetchAll(baseUrl, serviceKey, 'finance_protected_students?select=student_id'),
  ]);

  const gradeByLevelId = new Map(gradeRows.map((g) => [g.id, gradeFromCode(g.code)]));
  const campusByProgram = new Map(programRows.map((p) => [p.id, p.campus_id]));
  // program -> grade: prefer the grade_levels row on the program's own campus
  // (grade_levels has one row per campus with the same code).
  const gradeByProgram = new Map();
  for (const link of pglRows) {
    const campus = campusByProgram.get(link.program_id);
    const match = gradeRows.find(
      (g) => g.id === link.grade_level_id && (campus ? g.campus_id === campus : true),
    ) || gradeRows.find((g) => g.id === link.grade_level_id);
    if (match) gradeByProgram.set(link.program_id, gradeFromCode(match.code));
  }

  const cohorts = cohortRows.map((c) => ({
    id: c.id,
    name: c.name,
    grade: gradeByProgram.get(c.program_id) ?? gradeFromName(c.name),
    dayPair: dayPairFromPattern(c.schedule_pattern),
    capacity: typeof c.capacity === 'number' ? c.capacity : null,
  }));

  const activeStudentIds = new Set(
    studentRows.filter((s) => s.status === 'Active').map((s) => s.id),
  );
  const activeEnrollments = enrollmentRows
    .filter((e) => activeStudentIds.has(e.student_id))
    .map((e) => ({ studentId: e.student_id, cohortId: e.cohort_id }));

  const studentsById = {};
  for (const s of studentRows) {
    studentsById[s.id] = { grade: gradeByLevelId.get(s.grade_level_id) ?? null };
  }

  return {
    cohorts,
    activeEnrollments,
    studentsById,
    guardians: guardianRows.map((g) => ({ id: g.id, phone: g.phone })),
    guardianStudents: relRows.map((r) => ({ guardianId: r.guardian_id, studentId: r.student_id })),
    protectedIds: new Set(protectedRows.map((r) => r.student_id)),
  };
}

// ---------------------------------------------------------------------------
// Snapshot adapter (offline verification only)
// Fixture shape:
//   { cohorts: [{id,name,schedule_pattern,capacity,status,grade_code}],
//     student_cohorts: [{student_id, cohort_id, guardian_id, status}],
//     guardians: [{guardian_id, guardian_phone}],
//     protected_student_ids: [] }
// student_cohorts rows are Active enrolments of Active students (the Nov 2
// platform recon extract), one row per student/cohort pairing.
// ---------------------------------------------------------------------------

function loadFromSnapshot() {
  const file = process.env.SNAPSHOT_FILE;
  if (!file) throw new Error('SNAPSHOT_FILE must be set for the snapshot adapter');
  const fx = JSON.parse(fs.readFileSync(file, 'utf8'));

  const cohorts = (fx.cohorts || [])
    .filter((c) => c.status === 'Active')
    .map((c) => ({
      id: c.id,
      name: c.name,
      grade: gradeFromCode(c.grade_code) ?? gradeFromName(c.name),
      dayPair: dayPairFromPattern(c.schedule_pattern),
      capacity: typeof c.capacity === 'number' ? c.capacity : null,
    }));
  const cohortById = new Map(cohorts.map((c) => [c.id, c]));

  const activeEnrollments = [];
  const studentsById = {};
  const guardianStudents = [];
  const seenPair = new Set();
  for (const row of fx.student_cohorts || []) {
    const pairKey = `${row.student_id}|${row.cohort_id}`;
    if (!seenPair.has(pairKey)) {
      seenPair.add(pairKey);
      activeEnrollments.push({ studentId: row.student_id, cohortId: row.cohort_id });
    }
    const cohort = cohortById.get(row.cohort_id);
    if (!studentsById[row.student_id]) {
      studentsById[row.student_id] = { grade: cohort ? cohort.grade : null };
    }
    if (row.guardian_id) {
      guardianStudents.push({ guardianId: row.guardian_id, studentId: row.student_id });
    }
  }

  return {
    cohorts,
    activeEnrollments,
    studentsById,
    guardians: (fx.guardians || []).map((g) => ({ id: g.guardian_id, phone: g.guardian_phone })),
    guardianStudents,
    protectedIds: new Set(fx.protected_student_ids || []),
  };
}

// ---------------------------------------------------------------------------

let cache = null;
let cacheAt = 0;
const CACHE_MS = 30 * 1000; // counts stay effectively live; guards against bursts

async function loadData() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_MS) return cache;
  const adapter = (process.env.DATA_ADAPTER || 'supabase').toLowerCase();
  cache = adapter === 'snapshot' ? loadFromSnapshot() : await loadFromSupabase();
  cacheAt = now;
  return cache;
}

module.exports = { loadData, gradeFromCode, gradeFromName, dayPairFromPattern };
