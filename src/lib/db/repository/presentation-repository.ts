export {
  getAdminPresentation,
  getAdminPresentationControls,
  getAdminPresentationDeck,
  getParticipantResult,
  getPublicPresentation,
} from "./presentation-repository.reads";
export type {
  AdminPresentationControls,
  ParticipantResult,
  ParticipantResultQuestion,
  PresentationAction,
  PresentationState,
} from "./presentation-repository.reads";
export {
  operatePresentation,
  operatePresentationControls,
  setParticipantResultsVisible,
  PresentationConflictError,
} from "./presentation-repository.mutations";
