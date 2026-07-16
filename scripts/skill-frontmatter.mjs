import * as YAML from "yaml";

export function parseSkillFrontmatter(content) {
  const opening = /^---\r?\n/u.exec(content);
  if (!opening) throw new Error("Skill is missing opening YAML frontmatter delimiter.");
  const remainder = content.slice(opening[0].length);
  const closing = /^---\s*$/mu.exec(remainder);
  if (!closing) throw new Error("Skill is missing closing YAML frontmatter delimiter.");
  const source = remainder.slice(0, closing.index);
  const document = YAML.parseDocument(source, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`Skill frontmatter is invalid: ${document.errors[0].message}`);
  }
  const value = document.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Skill frontmatter must be a YAML mapping.");
  }
  if (typeof value.name !== "string" || !value.name.trim()) {
    throw new Error("Skill frontmatter must declare a name.");
  }
  if (typeof value.description !== "string" || !value.description.trim()) {
    throw new Error("Skill frontmatter must declare a description.");
  }
  return value;
}
