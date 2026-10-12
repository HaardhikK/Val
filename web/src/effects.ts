// Little effects around the character: hearts on a tap, dizzy stars after a tumble or a fall.
import * as THREE from "three";

export const CREAM = "#f4ead5";
export const PINK = "#ffb3c8";
export const AMBER = "#ffb000";

function emojiTexture(char: string, color = CREAM) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.font = "52px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = color;
  g.fillText(char, 32, 36);
  return new THREE.CanvasTexture(c);
}

interface Particle {
  sprite: THREE.Sprite;
  age: number;
  life: number;
  update: (p: Particle, t: number) => void;
}

/** Hearts that float up and fade; stars that orbit the head. */
export class Effects {
  private particles: Particle[] = [];
  // Solid palette glyphs, not colour emoji: pink hearts, amber stars.
  private heart = new THREE.SpriteMaterial({ map: emojiTexture("♥", PINK), transparent: true, depthWrite: false });
  private star = new THREE.SpriteMaterial({ map: emojiTexture("★", AMBER), transparent: true, depthWrite: false });
  private twinkle = new THREE.SpriteMaterial({ map: emojiTexture("✦"), transparent: true, depthWrite: false, color: 0xffd6ec });
  /** One material (and canvas texture) per pop emoji, drawn once; each pop clones it for its own opacity. */
  private pops = new Map<string, THREE.SpriteMaterial>();

  constructor(private parent: THREE.Object3D) {}

  /** Live particles (the idle frame cap waits until there are none). */
  get count() {
    return this.particles.length;
  }

  /**
   * Compile the sprite program once, in idle time after load, so the first tap or fall does not stall on it. The
   * sprite is visible for the compile only and removed before anything is drawn. Textures: warmTextures.
   */
  warmUp(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const sprite = new THREE.Sprite(this.heart);
    this.parent.add(sprite);
    renderer.compile(scene, camera);
    this.parent.remove(sprite);
  }

  /** Upload the heart and star textures once, so the first tap or fall does not wait for them. */
  warmTextures(renderer: THREE.WebGLRenderer) {
    for (const m of [this.heart, this.star]) if (m.map) renderer.initTexture(m.map);
  }

  hearts(at: THREE.Vector3, count = 4) {
    for (let i = 0; i < count; i++) {
      const sprite = new THREE.Sprite(this.heart.clone());
      const dx = (Math.random() - 0.5) * 0.8;
      const delay = i * 0.12;
      sprite.scale.setScalar(0.35);
      this.add(sprite, 1.4 + delay, (p, t) => {
        const k = Math.max(0, t - delay) / (p.life - delay);
        p.sprite.position.set(at.x + dx * k + Math.sin(k * 9 + i) * 0.08, at.y + k * 1.4, at.z + 0.3);
        (p.sprite.material as THREE.SpriteMaterial).opacity = t < delay ? 0 : 1 - k;
        p.sprite.scale.setScalar(0.25 + 0.15 * Math.sin(Math.min(k, 1) * Math.PI));
      });
    }
  }

  stars(around: () => THREE.Vector3, seconds = 2.6) {
    for (let i = 0; i < 3; i++) {
      const sprite = new THREE.Sprite(this.star.clone());
      sprite.scale.setScalar(0.28);
      this.add(sprite, seconds, (p, t) => {
        const c = around();
        const a = t * 5 + (i * Math.PI * 2) / 3;
        p.sprite.position.set(c.x + Math.cos(a) * 0.55, c.y + 0.15 + Math.sin(a * 2) * 0.05, c.z + Math.sin(a) * 0.3);
        (p.sprite.material as THREE.SpriteMaterial).opacity = Math.min(1, (p.life - t) * 2);
      });
    }
  }

  /** Tiny ✦ sparkles that blink in and out over the head, one after another (looking at the sky, help). */
  twinkles(around: () => THREE.Vector3, count = 4, seconds = 1.1) {
    for (let i = 0; i < count; i++) {
      const sprite = new THREE.Sprite(this.twinkle.clone());
      const dx = (i / Math.max(1, count - 1) - 0.5) * 1.3 + (Math.random() - 0.5) * 0.15;
      const dy = 0.85 + Math.random() * 0.4 - Math.abs(dx) * 0.3; // an arc over the head
      const delay = i * 0.14;
      sprite.scale.setScalar(0);
      this.add(sprite, seconds + delay, (p, t) => {
        const k = Math.max(0, t - delay) / seconds;
        const c = around();
        p.sprite.position.set(c.x + dx, c.y + dy + k * 0.15, c.z + 0.2);
        p.sprite.scale.setScalar(0.3 *Math.sin(Math.min(k, 1) * Math.PI));
      });
    }
  }

  /** One emoji that pops up, wobbles and fades (📸 on a wiggle, 💤 while asleep, 💫 ripples). */
  pop(char: string, at: () => THREE.Vector3, seconds = 1.2, rise = 0.6, color = CREAM) {
    const key = char + color;
    let base = this.pops.get(key);
    if (!base) {
      base = new THREE.SpriteMaterial({ map: emojiTexture(char, color), transparent: true, depthWrite: false });
      this.pops.set(key, base);
    }
    const sprite = new THREE.Sprite(base.clone());
    this.add(sprite, seconds, (p, t) => {
      const k = t / p.life;
      const c = at();
      p.sprite.position.set(c.x + Math.sin(k * 7) * 0.08, c.y + k * rise, c.z + 0.3);
      p.sprite.scale.setScalar(0.42 * Math.min(1, k * 5) * (1 + 0.1 * Math.sin(k * 20)));
      (p.sprite.material as THREE.SpriteMaterial).opacity = 1 - k * k;
    });
  }

  private add(sprite: THREE.Sprite, life: number, update: Particle["update"]) {
    this.parent.add(sprite);
    this.particles.push({ sprite, age: 0, life, update });
  }

  update(dt: number) {
    if (this.particles.length === 0) return;
    let kept = 0;
    for (const p of this.particles) {
      p.age += dt;
      p.update(p, p.age);
      if (p.age < p.life) {
        this.particles[kept++] = p;
        continue;
      }
      this.parent.remove(p.sprite);
      p.sprite.material.dispose(); // the clone only: textures are shared and kept
    }
    this.particles.length = kept;
  }
}
