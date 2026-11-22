import type { DetectionListener } from '../types.js';

export const personListener: DetectionListener = {
  kind: 'person',
  label: 'Human',
  matches: (cls) => cls === 'person',
  defaults: { enabled: true, notify: true, minConfidence: 0.55, cooldownSec: 10 },
};

// COCO animal classes.
const ANIMALS = new Set(['bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe']);

export const animalListener: DetectionListener = {
  kind: 'animal',
  label: 'Animal',
  matches: (cls) => ANIMALS.has(cls),
  defaults: { enabled: false, notify: true, minConfidence: 0.5, cooldownSec: 10 },
};

/**
 * Registered listeners, in display order. To add e.g. vehicles or packages, define a
 * listener here (or register one at runtime with ListenerRegistry.register).
 */
export class ListenerRegistry {
  private listeners = new Map<string, DetectionListener>();

  constructor(initial: DetectionListener[] = [personListener, animalListener]) {
    initial.forEach((l) => this.register(l));
  }

  register(l: DetectionListener) {
    this.listeners.set(l.kind, l);
  }

  all(): DetectionListener[] {
    return [...this.listeners.values()];
  }

  get(kind: string) {
    return this.listeners.get(kind);
  }

  /** The first listener whose class mapping covers `cls`. */
  classify(cls: string): DetectionListener | undefined {
    for (const l of this.listeners.values()) if (l.matches(cls)) return l;
    return undefined;
  }
}
