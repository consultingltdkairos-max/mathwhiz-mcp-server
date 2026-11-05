'use strict';
// The three read-only tools of the Mathwhiz MCP server (phase 1).
// Pure logic over the normalized dataset from data.js. No writes, ever.

const INTERNAL_CAP = 30; // placement fill-rule cap per class (Kevoy, Nov 1 2026)
const PARENT_FACING_CLASS_SIZE = 25; // size quoted to parents for Grades 7/8 (Kevoy, Nov 4 2026)

const DAY_PAIRS = [
  { key: 'monday_wednesday', label: 'Monday/Wednesday', long: 'Monday and Wednesday', fillOrder: ['M', 'T'] },
  { key: 'tuesday_thursday', label: 'Tuesday/Thursday', long: 'Tuesday and Thursday', fillOrder: ['A', 'H'] },
];

// Settled class times (Kevoy's rulings; the platform still shows pre-launch
// 6:00-7:00 PM patterns on the Grade 7/8 weekly cohorts, so times come from
// the settled facts, while days and class lists come from live platform data).
const CLASS_TIMES = {
  7: '6:30 PM - 7:30 PM',
  8: '6:30 PM - 7:30 PM',
  9: '6:30 PM - 8:00 PM',
  10: '6:30 PM - 8:00 PM',
  11: '6:30 PM - 8:00 PM',
};

function normalizeGrade(input) {
  if (input === null || input === undefined) return null;
  const m = /(\d{1,2})/.exec(String(input));
  if (!m) return null;
  const g = parseInt(m[1], 10);
  return g >= 7 && g <= 11 ? g : null;
}

function bandLetter(cohortName) {
  const m = /Grade\s+\d{1,2}\s*([A-Z])\b/i.exec(cohortName || '');
  return m ? m[1].toUpperCase() : null;
}

function salesClasses(data, grade) {
  // Weekday placement classes only: Sunday sessions and the demo class are
  // not placement classes (matches the Nov 3 capacity-check method).
  return data.cohorts.filter(
    (c) => c.grade === grade
      && (c.dayPair === 'monday_wednesday' || c.dayPair === 'tuesday_thursday')
      && !/demo/i.test(c.name),
  );
}

function enrolledByCohort(data) {
  const counts = new Map();
  const seen = new Set();
  for (const e of data.activeEnrollments) {
    const key = `${e.cohortId}|${e.studentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts.set(e.cohortId, (counts.get(e.cohortId) || 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Tool 1: get_class_availability
// ---------------------------------------------------------------------------

function getClassAvailability(data, args) {
  const grade = normalizeGrade(args && args.grade);
  if (!grade) return { error: 'grade must be one of 7, 8, 9, 10, 11' };

  const counts = enrolledByCohort(data);
  const classes = salesClasses(data, grade);
  const notes = [
    `Spaces are shown two ways: against the platform's recorded capacity where one exists, and against the internal placement cap of ${INTERNAL_CAP} per class.`,
    `Parents are quoted a class size of ${PARENT_FACING_CLASS_SIZE} for Grades 7 and 8.`,
  ];

  const dayPairs = {};
  let totalEnrolled = 0;
  for (const pair of DAY_PAIRS) {
    const pairClasses = classes
      .filter((c) => c.dayPair === pair.key)
      .sort((a, b) => {
        const ia = pair.fillOrder.indexOf(bandLetter(a.name));
        const ib = pair.fillOrder.indexOf(bandLetter(b.name));
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      })
      .map((c) => {
        const enrolled = counts.get(c.id) || 0;
        totalEnrolled += enrolled;
        if (c.capacity === null) {
          notes.push(`${c.name} has no capacity recorded on the platform, so spaces against recorded capacity cannot be calculated for it.`);
        }
        return {
          class: c.name,
          enrolled,
          platform_capacity: c.capacity,
          spaces_left_platform_capacity: c.capacity === null ? null : Math.max(0, c.capacity - enrolled),
          spaces_left_internal_cap_30: Math.max(0, INTERNAL_CAP - enrolled),
        };
      });
    dayPairs[pair.key] = {
      days: pair.label,
      classes: pairClasses,
      total_enrolled: pairClasses.reduce((n, c) => n + c.enrolled, 0),
    };
  }

  return {
    grade,
    grade_label: `Grade ${grade}`,
    total_enrolled: totalEnrolled,
    day_pairs: dayPairs,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Tool 2: get_child_status
// ---------------------------------------------------------------------------

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function getChildStatus(data, args) {
  const target = normalizePhone(args && args.guardian_phone);
  if (!target || target.length < 7) {
    return { found: false, reason: 'no usable phone number was provided' };
  }

  const matchedGuardians = new Set(
    data.guardians.filter((g) => normalizePhone(g.phone) === target).map((g) => g.id),
  );
  if (matchedGuardians.size === 0) return { found: false };

  const cohortById = new Map(data.cohorts.map((c) => [c.id, c]));
  const enrollmentsByStudent = new Map();
  for (const e of data.activeEnrollments) {
    if (!enrollmentsByStudent.has(e.studentId)) enrollmentsByStudent.set(e.studentId, []);
    enrollmentsByStudent.get(e.studentId).push(e.cohortId);
  }

  const childIds = [];
  const seenChild = new Set();
  for (const rel of data.guardianStudents) {
    if (!matchedGuardians.has(rel.guardianId)) continue;
    if (data.protectedIds.has(rel.studentId)) continue; // platform finance fence
    if (seenChild.has(rel.studentId)) continue;
    seenChild.add(rel.studentId);
    childIds.push(rel.studentId);
  }
  if (childIds.length === 0) return { found: false };

  const children = childIds.map((studentId) => {
    const student = data.studentsById[studentId] || { grade: null };
    const activeCohorts = (enrollmentsByStudent.get(studentId) || [])
      .map((id) => cohortById.get(id))
      .filter((c) => c && (c.dayPair === 'monday_wednesday' || c.dayPair === 'tuesday_thursday'));
    const primary = activeCohorts[0] || null;
    const pair = primary ? DAY_PAIRS.find((p) => p.key === primary.dayPair) : null;
    const grade = student.grade ?? (primary ? primary.grade : null);
    return {
      enrolled: activeCohorts.length > 0,
      grade: grade ? `Grade ${grade}` : null,
      class_name: primary ? primary.name : null,
      class_days: pair ? pair.long : null,
    };
  });

  return { found: true, children };
}

// ---------------------------------------------------------------------------
// Tool 3: get_class_times
// ---------------------------------------------------------------------------

function getClassTimes(data, args) {
  const grade = normalizeGrade(args && args.grade);
  if (!grade) return { error: 'grade must be one of 7, 8, 9, 10, 11' };

  const classes = salesClasses(data, grade);
  const dayPairs = DAY_PAIRS
    .map((pair) => ({
      days: pair.long,
      classes: classes.filter((c) => c.dayPair === pair.key).map((c) => c.name),
    }))
    .filter((p) => p.classes.length > 0);

  return {
    grade,
    grade_label: `Grade ${grade}`,
    class_time: CLASS_TIMES[grade],
    day_pairs: dayPairs,
  };
}

const TOOLS = [
  {
    name: 'get_class_availability',
    description:
      'Live Mathwhiz class availability for one grade: enrolled count and spaces left for each class on the Monday/Wednesday and Tuesday/Thursday day pairs, counted live from platform student records. Counts only; no student data.',
    inputSchema: {
      type: 'object',
      properties: {
        grade: { type: 'integer', description: 'Grade level, one of 7, 8, 9, 10, 11', enum: [7, 8, 9, 10, 11] },
      },
      required: ['grade'],
      additionalProperties: false,
    },
    run: getClassAvailability,
  },
  {
    name: 'get_child_status',
    description:
      "Look up enrolment status for the children of the guardian with the given phone number (the caller's own number). Returns only that family's children: whether each child is enrolled, their grade and their class days. An unknown number returns found: false.",
    inputSchema: {
      type: 'object',
      properties: {
        guardian_phone: { type: 'string', description: "The guardian's own phone number, any format" },
      },
      required: ['guardian_phone'],
      additionalProperties: false,
    },
    run: getChildStatus,
  },
  {
    name: 'get_class_times',
    description:
      'Mathwhiz class times for one grade: the class time and which day pairs (Monday/Wednesday, Tuesday/Thursday) run classes for that grade, with the class names from the live platform.',
    inputSchema: {
      type: 'object',
      properties: {
        grade: { type: 'integer', description: 'Grade level, one of 7, 8, 9, 10, 11', enum: [7, 8, 9, 10, 11] },
      },
      required: ['grade'],
      additionalProperties: false,
    },
    run: getClassTimes,
  },
];

module.exports = { TOOLS, normalizeGrade, normalizePhone, INTERNAL_CAP };
