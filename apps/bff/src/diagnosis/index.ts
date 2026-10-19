/** C12 diagnosis engine (plan/12 T-41; 02 §7, 09 A1–A3, A6, ADR-26). */
export {
  DiagnosisEngine,
  diagnose,
  evalPredicate,
  inScope,
  noFixReasonOf,
  offerFor,
  readDiagnosis,
  selectPath,
} from './engine.js';
export type { DiagnosisEmission, DiagnosisResult } from './engine.js';
export { buildEvidence, loadEvidence, parseArtifactText, readAllEvents } from './evidence.js';
export type { RunEvidence } from './evidence.js';
export {
  LibraryError,
  checkFingerprint,
  loadLibrary,
  readLibrary,
  validatePredicate,
} from './library.js';
export type { Fingerprint, NoFixReason, Predicate } from './types.js';
