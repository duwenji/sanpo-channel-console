import type { components, paths } from './schema.js';

export type { components, paths };
export type Schemas = components['schemas'];
export type Problem = Schemas['Problem'];
export type ProblemCode = Problem['code'];
