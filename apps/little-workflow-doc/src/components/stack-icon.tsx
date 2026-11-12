import type { CSSProperties } from 'react';
import { STACK_ICON_ARTWORK, type StackIconName } from '@/lib/stack-icon-artwork';

export type { StackIconName } from '@/lib/stack-icon-artwork';

type StackIconProps = {
  name: StackIconName;
  size?: number;
  className?: string;
  /** Omit when adjacent text already names the product. */
  label?: string;
};

/** Server-rendered artwork; the single StackIconMotion controller owns playback. */
export function StackIcon({ name, size = 32, className = '', label }: StackIconProps) {
  const artwork = STACK_ICON_ARTWORK[name];

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={`stack-icon ${className}`.trim()}
      style={{ '--stack-icon-size': `${size}px` } as CSSProperties}
      data-stack-icon={name}
      data-avatar-state="plain"
      data-visible="false"
      focusable="false"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {artwork.paths.map((path, index) => <path key={index} {...path} />)}
      <g className="stack-avatar-eyes" transform={artwork.eyes.transform} fill={artwork.eyes.fill}>
        <g className={`stack-avatar-gaze ${artwork.eyes.gazeClass}`}>
          {artwork.eyes.ellipses.map(({ className: eyeClass, ...ellipse }) => (
            <ellipse key={eyeClass} className={`stack-avatar-eye ${eyeClass}`} {...ellipse} />
          ))}
        </g>
      </g>
    </svg>
  );
}
