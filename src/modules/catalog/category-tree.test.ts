import { describe, expect, it } from "vitest";
import { descendants, lineage, placementProblem, treeOrder } from "./category-tree";

const nodes = [
  { id: "bev", parentId: null, code: "BEV" },
  { id: "hot", parentId: "bev", code: "BEV-HOT" },
  { id: "coffee", parentId: "hot", code: "BEV-HOT-COF" },
  { id: "cold", parentId: "bev", code: "BEV-COLD" },
  { id: "dairy", parentId: null, code: "DAIRY" },
];
const parents = new Map(nodes.map((n) => [n.id, n.parentId]));

describe("category tree (ADR-134)", () => {
  it("walks up to the top and down to every subcategory", () => {
    expect(lineage("coffee", parents)).toEqual(["coffee", "hot", "bev"]);
    expect(lineage("dairy", parents)).toEqual(["dairy"]);
    expect(descendants("bev", nodes).sort()).toEqual(["coffee", "cold", "hot"]);
    expect(descendants("coffee", nodes)).toEqual([]);
  });

  it("refuses loops and more than three levels", () => {
    expect(placementProblem("bev", "coffee", nodes)).toBe("CATEGORY_LOOP");
    expect(placementProblem("hot", "hot", nodes)).toBe("CATEGORY_LOOP");
    // A new category under coffee would be the fourth level.
    expect(placementProblem(null, "coffee", nodes)).toBe("CATEGORY_TOO_DEEP");
    // Moving "hot" (two levels deep with coffee) under "dairy" makes three: fine.
    expect(placementProblem("hot", "dairy", nodes)).toBeNull();
    // Moving "bev" (three levels) under "dairy" makes four.
    expect(placementProblem("bev", "dairy", nodes)).toBe("CATEGORY_TOO_DEEP");
    expect(placementProblem(null, "hot", nodes)).toBeNull();
    expect(placementProblem("cold", null, nodes)).toBeNull();
  });

  it("orders parents before children with their paths", () => {
    const tree = treeOrder(nodes);
    expect(tree.map((n) => `${"-".repeat(n.depth)}${n.code}`)).toEqual([
      "BEV",
      "-BEV-COLD",
      "-BEV-HOT",
      "--BEV-HOT-COF",
      "DAIRY",
    ]);
    expect(tree[3].path.map((p) => p.code)).toEqual(["BEV", "BEV-HOT", "BEV-HOT-COF"]);
  });
});
