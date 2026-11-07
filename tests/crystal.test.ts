import { expect, test } from 'bun:test';
import { CRYSTAL_SHAPES, crystalGeometry } from '../src/blob/crystal';
import { mulberry32 } from '../src/blob/seed';

test('Crystal facets tile every silhouette with shared edges and no folded or overlapping faces', () => {
  for (const shape of CRYSTAL_SHAPES) for (let seed = 0; seed < 100; seed++) {
    const geometry = crystalGeometry(mulberry32(seed), mulberry32(seed + 1), shape);
    const { vertices, facets, rimCount } = geometry;
    const edges = new Map<string, Array<[number, number]>>();
    let faceArea = 0;
    for (const facet of facets) {
      const [a, b, c] = facet.vertices.map(index => vertices[index]);
      const area = ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
      expect(area).toBeGreaterThan(0); // A folded face reverses winding and overlaps its neighbour.
      faceArea += area;
      facet.vertices.forEach((start, index) => {
        const end = facet.vertices[(index + 1) % 3];
        const key = [start, end].sort((a, b) => a - b).join(':');
        edges.set(key, [...(edges.get(key) ?? []), [start, end]]);
      });
    }
    const rimEdges = new Set(Array.from({ length: rimCount }, (_, index) =>
      [index, (index + 1) % rimCount].sort((a, b) => a - b).join(':')));
    for (const [key, uses] of edges) {
      expect(uses).toHaveLength(rimEdges.has(key) ? 1 : 2);
      if (uses.length === 2) expect(uses[0]).toEqual([uses[1][1], uses[1][0]]);
    }
    expect(vertices.length - edges.size + facets.length).toBe(1); // One connected surface, no holes.
    const rimArea = vertices.slice(0, rimCount).reduce((sum, point, index) => {
      const next = vertices[(index + 1) % rimCount];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2;
    expect(faceArea).toBeCloseTo(rimArea, 6);
  }
});

test('Crystal reflections use the same corners as their faces, with stable geometry and lighting', () => {
  for (const shape of CRYSTAL_SHAPES) {
    const make = () => crystalGeometry(mulberry32(42), mulberry32(11), shape);
    const geometry = make();
    expect(geometry).toEqual(make());
    expect(new Set(geometry.facets.map(facet => facet.kind))).toEqual(new Set(['lit', 'shade', 'soft']));
    for (const facet of geometry.facets) {
      expect(facet.opacity).toBeGreaterThanOrEqual(0);
      expect(facet.opacity).toBeLessThanOrEqual(.3);
      const [a, b, c, d, e, f] = facet.reflectionTransform.slice(7, -1).split(' ').map(Number);
      for (const [index, [x, y]] of [[0, 0], [100, 0], [50, 100]].entries()) {
        const corner = geometry.vertices[facet.vertices[index]];
        expect(a * x + c * y + e).toBeCloseTo(corner[0], 6);
        expect(b * x + d * y + f).toBeCloseTo(corner[1], 6);
      }
    }
  }
});
