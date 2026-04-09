export function validateSnapshot(snapshot) {
  const errors = [];
  if (!snapshot || typeof snapshot !== "object") {
    return { ok: false, errors: ["snapshot is not an object"] };
  }
  if (!snapshot.collectedAt || Number.isNaN(Date.parse(snapshot.collectedAt))) {
    errors.push("collectedAt missing or invalid");
  }
  if (!Array.isArray(snapshot.sections)) {
    errors.push("sections missing or not an array");
  } else {
    snapshot.sections.forEach((section, index) => {
      if (!section || typeof section !== "object") {
        errors.push(`section[${index}] is not an object`);
        return;
      }
      if (!section.id) {
        errors.push(`section[${index}] missing id`);
      }
      if (!Array.isArray(section.groups)) {
        errors.push(`section[${index}] groups missing or not an array`);
        return;
      }
      section.groups.forEach((group, groupIndex) => {
        if (!group || typeof group !== "object") {
          errors.push(`section[${index}].groups[${groupIndex}] is not an object`);
          return;
        }
        if (!Array.isArray(group.items)) {
          errors.push(`section[${index}].groups[${groupIndex}].items missing or not an array`);
          return;
        }
        group.items.forEach((item, itemIndex) => {
          if (!item || typeof item !== "object") {
            errors.push(`section[${index}].groups[${groupIndex}].items[${itemIndex}] is not an object`);
            return;
          }
          if (!item.text) {
            errors.push(`section[${index}].groups[${groupIndex}].items[${itemIndex}] missing text`);
          }
        });
      });
    });
  }
  return { ok: errors.length === 0, errors };
}
