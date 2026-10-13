import type { Rule } from 'eslint';

export const RAW_HTTP_MODULES: string[];
export const NO_RAW_HTTP_IMPORTS: { paths: { name: string; message: string }[] };
export const NO_RAW_HTTP_GLOBALS: { name: string; message: string }[];
export const NO_RAW_HTTP_FILES: string[];
export const NO_RAW_HTTP_ALLOWED: string[];
export const EVENT_TABLES: string[];
export const ALLOWED_DEPENDENCIES: Record<string, string[]>;
declare const plugin: {
  meta: { name: string; version: string };
  rules: {
    'sink-only-writer': Rule.RuleModule;
    'ui-imports-api-only': Rule.RuleModule;
    'dependency-direction': Rule.RuleModule;
    'no-localhost-literals': Rule.RuleModule;
  };
};
export default plugin;
