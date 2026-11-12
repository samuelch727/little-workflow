// Geometry and colors are transcribed unchanged from the user-supplied SVGs.
// See ../../assets/icons/README.md for source files and playback provenance.
type IconPath = {
  d: string;
  fill: string;
  stroke?: string;
  strokeWidth?: string;
  strokeLinecap?: 'round';
};

type IconArtwork = {
  paths: readonly IconPath[];
  eyes: {
    transform: string;
    fill: string;
    gazeClass: string;
    ellipses: readonly { className: string; cx: string; cy: string; rx: string; ry: string }[];
  };
};

export const STACK_ICON_ARTWORK = {
  brand: {
    paths: [
      {"fill": "#2B7751", "d": "M5 26.4Q5 25 6.7 24.02l16.6-9.63q1.7-.99 3.4-.01l14.6 8.44Q43 23.8 43 25.75v5.5q0 1.95-1.7 2.94l-16.6 9.62q-1.7.99-3.4.01L6.7 35.38Q5 34.4 5 32.45Z"},
      {"fill": "#73AF66", "d": "M23 37.35q0-1.95 1.7-2.94l16.6-9.63q1.7-.98 1.7.97v5.5q0 1.95-1.7 2.94l-16.6 9.62q-1.7.99-1.7-.96Z"},
      {"fill": "#7DB968", "d": "m6.7 24.02 16.6-9.63q1.7-.99 3.4-.01l14.6 8.44q1.7.98 0 1.96l-16.6 9.63q-1.7.99-3.4.01L6.7 25.98q-1.7-.98 0-1.96Z"},
      {"fill": "#69A35D", "d": "M11.5 14.2q0-1.7 1.5-2.57l11.8-6.84q1.5-.87 3 0l9.7 5.62Q39 11.28 39 13.01v6.18q0 1.73-1.5 2.6l-11.8 6.84q-1.5.87-3 0L13 23.01q-1.5-.87-1.5-2.6Z"},
      {"fill": "#418E50", "d": "M24.2 21.59q0-1.73 1.5-2.6l11.8-6.84q1.5-.87 1.5.86v6.18q0 1.73-1.5 2.6l-11.8 6.84q-1.5.87-1.5-.86Z"},
      {"fill": "#ADCE88", "d": "m13 11.63 11.8-6.84q1.5-.87 3 0l9.7 5.62q1.5.87 0 1.74l-11.8 6.84q-1.5.87-3 0L13 13.37q-1.5-.87 0-1.74Z"},
    ],
    eyes: {
      transform: "matrix(1 -.58 0 1 0 0) translate(33 52.9)",
      fill: "#193B2B",
      gazeClass: "stack-gaze",
      ellipses: [
        {"className": "stack-eye stack-left", "cx": "-3.75", "cy": "0", "rx": "1.3", "ry": "1.85"},
        {"className": "stack-eye stack-right", "cx": "3.75", "cy": "0", "rx": "1.3", "ry": "1.85"},
      ],
    },
  },
  harness: {
    paths: [
      {"fill": "none", "stroke": "#2B7751", "strokeWidth": "6.6", "strokeLinecap": "round", "d": "M15 10h-1.25a6 6 0 0 0-6 6v16a6 6 0 0 0 6 6H15m18-28h1.25a6 6 0 0 1 6 6v16a6 6 0 0 1-6 6H33"},
      {"fill": "#A6CD7C", "d": "M22.55 15.4q1.45-3.7 2.9 0c1.1 3.6 3.55 6.05 7.15 7.15q3.7 1.45 0 2.9c-3.6 1.1-6.05 3.55-7.15 7.15q-1.45 3.7-2.9 0c-1.1-3.6-3.55-6.05-7.15-7.15q-3.7-1.45 0-2.9c3.6-1.1 6.05-3.55 7.15-7.15Z"},
    ],
    eyes: {
      transform: "translate(24 24)",
      fill: "#233F2D",
      gazeClass: "harness-gaze",
      ellipses: [
        {"className": "harness-eye harness-left", "cx": "-2.8", "cy": "0", "rx": "1.12", "ry": "1.65"},
        {"className": "harness-eye harness-right", "cx": "2.8", "cy": "0", "rx": "1.12", "ry": "1.65"},
      ],
    },
  },
  workflow: {
    paths: [
      {"fill": "none", "stroke": "#BD591F", "strokeWidth": "4.8", "strokeLinecap": "round", "d": "M15 24h3.5a5 5 0 0 0 5-5v-2.5a5 5 0 0 1 5-5H34M18.5 24a5 5 0 0 1 5 5v1.5a5 5 0 0 0 5 5H34"},
      {"fill": "none", "stroke": "#BD591F", "strokeWidth": "3.8", "strokeLinecap": "round", "d": "M36 43H16a5 5 0 0 1-5-5v-5"},
      {"fill": "#BD591F", "d": "M10.2 31.6q.8-.9 1.6 0l3.1 3.4q.75.85-.4 1h-7q-1.15-.15-.4-1Z"},
      {"fill": "#FFB96B", "d": "M8.3 15.5h6.4a4.8 4.8 0 0 1 4.8 4.8v7.4a4.8 4.8 0 0 1-4.8 4.8H8.3a4.8 4.8 0 0 1-4.8-4.8v-7.4a4.8 4.8 0 0 1 4.8-4.8Z"},
      {"fill": "#EE9B44", "d": "M35 5h5a4 4 0 0 1 4 4v5a4 4 0 0 1-4 4h-5a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4Zm0 24h5a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4h-5a4 4 0 0 1-4-4v-7a4 4 0 0 1 4-4Z"},
    ],
    eyes: {
      transform: "translate(11.5 24)",
      fill: "#613921",
      gazeClass: "workflow-gaze",
      ellipses: [
        {"className": "workflow-eye workflow-left", "cx": "-2.75", "cy": "0", "rx": "1.2", "ry": "1.8"},
        {"className": "workflow-eye workflow-right", "cx": "2.75", "cy": "0", "rx": "1.2", "ry": "1.8"},
      ],
    },
  },
  littledb: {
    paths: [
      {"fill": "#795CAB", "d": "M12.5 5.5h15a7.5 7.5 0 0 1 7.5 7.5v14a7.5 7.5 0 0 1-7.5 7.5h-15A7.5 7.5 0 0 1 5 27V13a7.5 7.5 0 0 1 7.5-7.5Z"},
      {"fill": "#C0A3E2", "d": "M20.5 13.5h15a7.5 7.5 0 0 1 7.5 7.5v14a7.5 7.5 0 0 1-7.5 7.5h-15A7.5 7.5 0 0 1 13 35V21a7.5 7.5 0 0 1 7.5-7.5Z"},
    ],
    eyes: {
      transform: "translate(28 28.1)",
      fill: "#4B326B",
      gazeClass: "database-gaze",
      ellipses: [
        {"className": "database-eye database-left", "cx": "-4.05", "cy": "0", "rx": "1.55", "ry": "2.2"},
        {"className": "database-eye database-right", "cx": "4.05", "cy": "0", "rx": "1.55", "ry": "2.2"},
      ],
    },
  },
  compute: {
    paths: [
      {"fill": "#30729A", "d": "M16.5 8h15a8.5 8.5 0 0 1 8.5 8.5v15a8.5 8.5 0 0 1-8.5 8.5h-15A8.5 8.5 0 0 1 8 31.5v-15A8.5 8.5 0 0 1 16.5 8Z"},
      {"fill": "none", "stroke": "#65A6D1", "strokeWidth": "6", "strokeLinecap": "round", "d": "M24 6v5m0 26v5M6 24h5m26 0h5"},
      {"fill": "#9ACDEE", "d": "M18.75 14.75h10.5a4.5 4.5 0 0 1 4.5 4.5v9.5a4.5 4.5 0 0 1-4.5 4.5h-10.5a4.5 4.5 0 0 1-4.5-4.5v-9.5a4.5 4.5 0 0 1 4.5-4.5Z"},
    ],
    eyes: {
      transform: "translate(24 24)",
      fill: "#214763",
      gazeClass: "compute-gaze",
      ellipses: [
        {"className": "compute-eye compute-left", "cx": "-3.65", "cy": "0", "rx": "1.45", "ry": "2.05"},
        {"className": "compute-eye compute-right", "cx": "3.65", "cy": "0", "rx": "1.45", "ry": "2.05"},
      ],
    },
  },
} as const satisfies Record<string, IconArtwork>;

export type StackIconName = keyof typeof STACK_ICON_ARTWORK;

// Plain SVGs have no client dependency, eye layer, animation, or external asset.
export function getStackIconSvg(name: StackIconName): string {
  const paths = STACK_ICON_ARTWORK[name].paths.map((path) => {
    const attributes = Object.entries(path).map(([key, value]) => {
      const attribute = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      return `${attribute}="${value}"`;
    }).join(' ');
    return `<path ${attributes} />`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">${paths}</svg>`;
}

export function getStackIconDataUri(name: StackIconName): string {
  return `data:image/svg+xml,${encodeURIComponent(getStackIconSvg(name))}`;
}
