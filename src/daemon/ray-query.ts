import { createRequire } from "node:module";
import { Vec3 } from "vec3";

type Shape = [number, number, number, number, number, number];
type RayBlock = { shapes?: Shape[] };
type Pose = { position?: { x: number; y: number; z: number }; yaw?: number; pitch?: number; height?: number };
type BlockWorld<T> = { getBlock(position: Vec3): T | null | undefined };
type Iterator = {
  next(): { x: number; y: number; z: number } | null;
  intersect(shapes: Shape[], offset: Vec3): { pos: Vec3 } | null;
};
const { RaycastIterator } = createRequire(import.meta.url)("prismarine-world").iterators as {
  RaycastIterator: new (origin: Vec3, direction: Vec3, range: number) => Iterator;
};

/** A miss is known only if every voxel before the end of the ray was loaded. */
export function queryBlockRay<T extends RayBlock>(world: BlockWorld<T> | null | undefined, pose: Pose | undefined, range: number):
  { known: false } | { known: true; block: T | null } {
  const position = pose?.position;
  if (!world || typeof world.getBlock !== "function" || !position ||
      ![position.x, position.y, position.z, pose.yaw, pose.pitch, pose.height, range].every(value => typeof value === "number" && Number.isFinite(value)) ||
      pose.height! <= 0 || range < 0) return { known: false };
  // Retain Mineflayer's block cursor origin (entity height), including valid zero angles.
  const origin = new Vec3(position.x, position.y + pose.height!, position.z);
  const direction = new Vec3(-Math.sin(pose.yaw!) * Math.cos(pose.pitch!), Math.sin(pose.pitch!), -Math.cos(pose.yaw!) * Math.cos(pose.pitch!)).normalize();
  const iterator = new RaycastIterator(origin, direction, range);
  let voxel: { x: number; y: number; z: number } | null = origin.floored();
  while (voxel) {
    const offset = new Vec3(voxel.x, voxel.y, voxel.z);
    const block = world.getBlock(offset);
    if (block == null || !Array.isArray(block.shapes)) return { known: false };
    const localOrigin = origin.minus(offset);
    const inside = block.shapes.some(shape => localOrigin.x > shape[0] && localOrigin.y > shape[1] && localOrigin.z > shape[2] &&
      localOrigin.x < shape[3] && localOrigin.y < shape[4] && localOrigin.z < shape[5]);
    if (inside) return { known: true, block };
    for (const shape of block.shapes) {
      // A shape behind the origin must not hide a forward hit in another shape
      // of the same block (for example, the upper half of a stair).
      const hit = iterator.intersect([shape], offset);
      if (hit) {
        const hitDistance = hit.pos.minus(origin).dot(direction);
        // The dependency intersects an entire voxel, which can extend past range.
        if (hitDistance >= 0 && hitDistance <= range) return { known: true, block };
      }
    }
    voxel = iterator.next();
  }
  return { known: true, block: null };
}
