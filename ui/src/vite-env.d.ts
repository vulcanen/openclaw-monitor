/// <reference types="vite/client" />

// Ambient declarations so TypeScript 6's stricter side-effect-import rule
// (TS2882) doesn't reject `import "./styles.css"`. Vite handles CSS at
// build time; from TypeScript's perspective these are just opaque modules.
declare module "*.css";
declare module "*.svg";
declare module "*.png";
