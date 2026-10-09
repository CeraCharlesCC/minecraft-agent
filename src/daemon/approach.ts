import pathfinderPackage from "mineflayer-pathfinder";
import type { Move } from "mineflayer-pathfinder";

type Position = { x: number; y: number; z: number };

/** All reachable standing nodes in range are alternative destinations. */
export class ApproachGoal extends pathfinderPackage.goals.Goal {
  constructor(readonly target: Position, readonly range: number) { super(); }

  distance(position: Position): number {
    return Math.hypot(position.x - this.target.x, position.y - this.target.y, position.z - this.target.z);
  }

  nodeDistance(node: Position): number {
    return this.distance({ x: node.x + 0.5, y: node.y, z: node.z + 0.5 });
  }

  heuristic(node: Move): number { return Math.max(0, this.nodeDistance(node) - this.range); }
  isEnd(node: Move): boolean { return this.nodeDistance(node) <= this.range; }
}
