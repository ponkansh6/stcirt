# Plan 78: shared component case ledger

**Current scope:** the three remaining runtime component suites: Button (5 cases), ChoiceButton (7 cases), and Spinner (1 case). These 13 current component cases passed in both the prior 1,111-case run and the final post-retirement 1,108-case coverage run; the latter passed all four coverage metrics at 100%.

## Active component cases

| ID             | Source / title                                                                                                                        | Current disposition | Contract observed                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------- |
| COMP78-BTN-01  | [`Button.test.tsx:6`](../../tests/components/Button.test.tsx#L6) renders children and stays enabled by default                        | Keep · P2           | Accessible button name, enabled state, no busy marker.                          |
| COMP78-BTN-02  | [`Button.test.tsx:13`](../../tests/components/Button.test.tsx#L13) when loading, disables the button and sets aria-busy               | Keep · P1           | Loading disables the named button and sets `aria-busy`.                         |
| COMP78-BTN-03  | [`Button.test.tsx:20`](../../tests/components/Button.test.tsx#L20) when loading, renders an inline spinner                            | Keep · P2           | Loading indicator appears inside the Button.                                    |
| COMP78-BTN-04  | [`Button.test.tsx:25`](../../tests/components/Button.test.tsx#L25) loading overrides an explicit disabled prop                        | Keep · P2           | Button remains disabled when both props are true.                               |
| COMP78-BTN-05  | [`Button.test.tsx:34`](../../tests/components/Button.test.tsx#L34) renders danger variant with error-token classes                    | Keep · P2           | Danger variant maps to error background and on-primary text tokens.             |
| COMP78-CHO-01  | [`ChoiceButton.test.tsx:6`](../../tests/components/ChoiceButton.test.tsx#L6) renders label and text in idle variant by default        | Keep · P2           | Visible label/text and a named, enabled, unchecked native radio.                |
| COMP78-CHO-02  | [`ChoiceButton.test.tsx:30`](../../tests/components/ChoiceButton.test.tsx#L30) renders the selected mark and a checked native radio   | Keep · P1           | Checked native radio and selected marker agree.                                 |
| COMP78-CHO-03a | [`ChoiceButton.test.tsx:46`](../../tests/components/ChoiceButton.test.tsx#L46) correct variant                                        | Keep · P2           | Correct variant class mapping.                                                  |
| COMP78-CHO-03b | Same parameterized declaration: selectedWrong variant                                                                                 | Keep · P2           | Selected-wrong variant class mapping.                                           |
| COMP78-CHO-03c | Same parameterized declaration: muted variant                                                                                         | Keep · P2           | Muted variant class mapping.                                                    |
| COMP78-CHO-04  | [`ChoiceButton.test.tsx:66`](../../tests/components/ChoiceButton.test.tsx#L66) changes the radio when its full row label is activated | Improve · P2        | `userEvent` invokes the callback once; controlled state changes after rerender. |
| COMP78-CHO-05  | [`ChoiceButton.test.tsx:84`](../../tests/components/ChoiceButton.test.tsx#L84) disables the radio while a submission is pending       | Keep · P1           | Native radio is disabled while submission is pending.                           |
| COMP78-SP-01   | [`Spinner.test.tsx:6`](../../tests/components/Spinner.test.tsx#L6) renders an aria-hidden spinner with default sm/current classes     | Improve · P2        | Confirms decorative hidden semantics and default classes.                       |

The three suites contain **13 current runtime cases** in **3 files**: 11 Keep and 2 Improve. These are source inventory counts, not test-run results.

## Retired by decision

Seven orphan component suites were removed along with their components. Spinner SP-02 and SP-03 were also retired. Stable COMP and VIT IDs remain gaps; results for retired cases are historical only. The 13 active Button/ChoiceButton/Spinner cases passed in the final 1,108-case full coverage run, as summarized above.

| Stable component ID | Former case                                                                    | Disposition | Decision                                          |
| ------------------- | ------------------------------------------------------------------------------ | ----------- | ------------------------------------------------- |
| COMP78-EMP-01       | EmptyState renders title and description                                       | Keep        | Retired with orphan EmptyState component suite.   |
| COMP78-ERR-01       | ErrorMessage renders message without retry button when onRetry is not provided | Keep        | Retired with orphan ErrorMessage component suite. |
| COMP78-ERR-02       | ErrorMessage renders retry button and calls it on click                        | Keep        | Retired with orphan ErrorMessage component suite. |
| COMP78-ERR-03       | ErrorMessage passes loading prop to the retry button                           | Keep        | Retired with orphan ErrorMessage component suite. |
| COMP78-LS-01        | LoadingState renders default label when none provided                          | Keep        | Retired with orphan LoadingState component suite. |
| COMP78-LS-02        | LoadingState renders custom label when provided                                | Keep        | Retired with orphan LoadingState component suite. |
| COMP78-NAV-01       | NavLink renders children and passes href and className to the link             | Keep        | Retired with orphan NavLink component suite.      |
| COMP78-NAV-02       | NavLink applies the pending class while navigation is pending                  | Keep        | Retired with orphan NavLink component suite.      |
| COMP78-NAV-03       | NavLink can receive keyboard focus as a native link                            | Keep        | Retired with orphan NavLink component suite.      |
| COMP78-NAV-04       | NavLink applies the primary button variant by default                          | Improve     | Retired with orphan NavLink component suite.      |
| COMP78-NAV-05       | NavLink applies the outline button variant when requested                      | Improve     | Retired with orphan NavLink component suite.      |
| COMP78-NAV-06       | NavLink omits button base and variant classes for bare variant                 | Keep        | Retired with orphan NavLink component suite.      |
| COMP78-NAV-07       | NavLink keeps extra className alongside the button variant                     | Improve     | Retired with orphan NavLink component suite.      |
| COMP78-PB-01        | ProgressBar renders correct width for 0.5                                      | Improve     | Retired with orphan ProgressBar component suite.  |
| COMP78-PB-02        | ProgressBar clamps values above 1 to 100%                                      | Improve     | Retired with orphan ProgressBar component suite.  |
| COMP78-PB-03        | ProgressBar clamps values below 0 to 0%                                        | Improve     | Retired with orphan ProgressBar component suite.  |
| COMP78-RB-01        | ResultBanner renders correct state when isCorrect is true                      | Keep        | Retired with orphan ResultBanner component suite. |
| COMP78-RB-02        | ResultBanner renders incorrect state when isCorrect is false                   | Keep        | Retired with orphan ResultBanner component suite. |
| COMP78-SC-01        | StatCard renders label and value without ring                                  | Keep        | Retired with orphan StatCard component suite.     |
| COMP78-SC-02        | StatCard renders with progress bar when progress prop is provided              | Improve     | Retired with orphan StatCard component suite.     |
| COMP78-SP-02        | Spinner renders lg size and primary color when requested                       | Improve     | Retired Spinner case.                             |
| COMP78-SP-03        | Spinner appends extra className                                                | Keep        | Retired Spinner case.                             |

Retired component cases total **14 Keep / 8 Improve**. The seven orphan suites account for 13 Keep / 7 Improve; SP-02 and SP-03 account for one Improve and one Keep.
