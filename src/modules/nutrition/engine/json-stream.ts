/**
 * Stream the records of a large JSON food file one at a time (ADR-132):
 * FoodData Central downloads ({"BrandedFoods": [ … ]}, {"FoundationFoods": …}),
 * a bare array, or JSON Lines. Memory holds one record at a time, never the
 * whole file. Pure: give it text chunks in order.
 */
export async function* jsonRecords(chunks: AsyncIterable<string>): AsyncGenerator<unknown> {
  let mode: "unknown" | "array" | "lines" = "unknown";
  let depth = 0; // nesting depth of the current position
  let recordDepth = -1; // depth at which records start ({ inside the records array)
  let inString = false;
  let escaped = false;
  let buf: string[] = [];
  let capturing = false;
  let line = "";
  for await (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (mode === "unknown") {
        if (/\s/.test(c)) continue;
        mode = c === "{" ? "array" : c === "[" ? "array" : "lines";
        if (c === "{") {
          // Could be a wrapper object or the first JSON line; a wrapper's first value is an array.
          depth = 1;
          buf = ["{"];
          capturing = true;
          recordDepth = -1;
          continue;
        }
        if (c === "[") {
          depth = 1;
          recordDepth = 1;
          continue;
        }
      }
      if (mode === "lines") {
        if (c === "\n") {
          if (line.trim()) yield JSON.parse(line);
          line = "";
        } else line += c;
        continue;
      }
      if (inString) {
        if (capturing) buf.push(c);
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
        if (capturing) buf.push(c);
        continue;
      }
      if (recordDepth === -1 && capturing) {
        // Inside the first top-level object: decide whether it wraps an array of records.
        buf.push(c);
        // A wrapper's first and only key holds the records: {"BrandedFoods": [ … ]}.
        if (c === "[" && depth === 1 && /^\{\s*"[^"\\]*"\s*:\s*\[$/.test(buf.join(""))) {
          recordDepth = 2;
          capturing = false;
          buf = [];
          depth = 2;
          continue;
        }
        if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") {
          depth--;
          if (depth === 0) {
            // A whole object with no records array: it is a single record (JSON Lines or one food).
            const text = buf.join("");
            buf = [];
            capturing = false;
            mode = "lines";
            yield JSON.parse(text);
          }
        }
        continue;
      }
      if (c === "{" || c === "[") {
        if (c === "{" && depth === recordDepth) {
          capturing = true;
          buf = [];
        }
        depth++;
        if (capturing) buf.push(c);
        continue;
      }
      if (c === "}" || c === "]") {
        if (capturing) buf.push(c);
        depth--;
        if (capturing && depth === recordDepth) {
          capturing = false;
          yield JSON.parse(buf.join(""));
          buf = [];
        }
        continue;
      }
      if (capturing) buf.push(c);
    }
  }
  if (mode === "lines" && line.trim()) yield JSON.parse(line);
  if (capturing && buf.length) throw new Error("The file ends in the middle of a record");
}
