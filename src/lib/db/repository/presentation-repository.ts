export {
  getAdminPresentation,
  getAdminPresentationControls,
  getAdminPresentationDeck,
  getParticipantResult,
  getParticipantResultState,
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
  setPresentationPosition,
  setParticipantResultsVisible,
  getPresentationReferenceNames,
  setPresentationReferenceNames,
  PresentationConflictError,
} from "./presentation-repository.mutations";
