export function makeItem(text, source, checkedAt, options = {}) {
  return {
    text,
    source,
    checkedAt,
    confidence: options.confidence || "measured",
    ok: options.ok !== false,
    detail: options.detail || null,
  };
}

export function measuredItem(text, source, checkedAt, detail) {
  return makeItem(text, source, checkedAt, { confidence: "measured", detail });
}

export function derivedItem(text, source, checkedAt, detail) {
  return makeItem(text, source, checkedAt, { confidence: "derived", detail });
}

export function inferredItem(text, source, checkedAt, detail) {
  return makeItem(text, source, checkedAt, { confidence: "inferred", detail });
}

export function unknownItem(text, source, checkedAt, detail) {
  return makeItem(text, source, checkedAt, { confidence: "unknown", ok: false, detail });
}

export function normalizeItem(item, collectedAt) {
  const allowedConfidence = new Set(["measured", "derived", "inferred", "unknown"]);
  const normalizeCheckedAt = (value) => {
    if (!value) {
      return collectedAt;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return collectedAt;
    }
    return date.toISOString();
  };

  if (typeof item === "string") {
    return inferredItem(item, "unspecified", collectedAt);
  }
  if (!item || typeof item !== "object") {
    return unknownItem("invalid item", "unspecified", collectedAt);
  }

  return {
    text: item.text ?? "missing text",
    source: item.source ?? "unspecified",
    checkedAt: normalizeCheckedAt(item.checkedAt),
    confidence: allowedConfidence.has(item.confidence) ? item.confidence : "inferred",
    ok: item.ok !== false,
    detail: item.detail ?? null,
  };
}

export function normalizeSections(sections, collectedAt) {
  return sections.map((section) => ({
    ...section,
    groups: (section.groups || []).map((group) => ({
      ...group,
      items: (group.items || []).map((item) => normalizeItem(item, collectedAt)),
    })),
  }));
}
