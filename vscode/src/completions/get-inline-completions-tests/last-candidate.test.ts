import dedent from 'dedent'
import { describe, expect, test } from 'vitest'
import { Range } from 'vscode'

import { vsCodeMocks } from '../../testutils/mocks'
import { range } from '../../testutils/textDocument'
import { InlineCompletionsResultSource, LastInlineCompletionCandidate } from '../getInlineCompletions'
import { documentAndPosition } from '../test-helpers'
import { getNextNonEmptyLine } from '../text-processing'

import { getInlineCompletions, params, V } from './helpers'

describe('[getInlineCompletions] reuseLastCandidate', () => {
    function lastCandidate(
        code: string,
        insertText: string | string[],
        lastTriggerSelectedInfoItem?: string
    ): LastInlineCompletionCandidate {
        const { document, position } = documentAndPosition(code)
        const suffix = document.getText(new Range(position, document.lineAt(document.lineCount - 1).range.end))
        const nextNonEmptyLine = getNextNonEmptyLine(suffix)
        return {
            uri: document.uri,
            lastTriggerPosition: position,
            lastTriggerCurrentLinePrefix: document.lineAt(position).text.slice(0, position.character),
            lastTriggerNextNonEmptyLine: nextNonEmptyLine,
            lastTriggerSelectedInfoItem,
            result: {
                logId: '1',
                items: Array.isArray(insertText) ? insertText.map(insertText => ({ insertText })) : [{ insertText }],
            },
        }
    }

    test('reused when typing forward as suggested', async () =>
        // The user types `\n`, sees ghost text `const x = 123`, then types `const x = 1` (i.e.,
        // all but the last 2 characters of the ghost text). The original completion should
        // still display.
        expect(
            await getInlineCompletions(
                params('\nconst x = 1█', [], { lastCandidate: lastCandidate('\n█', 'const x = 123') })
            )
        ).toEqual<V>({
            items: [{ insertText: '23' }],
            source: InlineCompletionsResultSource.LastCandidate,
        }))

    test('reused when typing forward as suggested through partial whitespace', async () =>
        // The user types ` `, sees ghost text ` x`, then types ` `. The original completion
        // should still display.
        expect(await getInlineCompletions(params('  █', [], { lastCandidate: lastCandidate(' █', ' x') }))).toEqual<V>({
            items: [{ insertText: 'x' }],
            source: InlineCompletionsResultSource.LastCandidate,
        }))

    test('reused when typing forward as suggested through all whitespace', async () =>
        // The user sees ghost text `  x`, then types `  `. The original completion should still
        // display.
        expect(await getInlineCompletions(params('  █', [], { lastCandidate: lastCandidate('█', '  x') }))).toEqual<V>({
            items: [{ insertText: 'x' }],
            source: InlineCompletionsResultSource.LastCandidate,
        }))

    test('reused when adding leading whitespace', async () =>
        // The user types ``, sees ghost text `x = 1`, then types ` ` (space). The original
        // completion should be reused.
        expect(await getInlineCompletions(params(' █', [], { lastCandidate: lastCandidate('█', 'x = 1') }))).toEqual<V>(
            {
                items: [{ insertText: 'x = 1' }],
                source: InlineCompletionsResultSource.LastCandidate,
            }
        ))

    test('reused when the deleting back to the start of the original trigger (but no further)', async () =>
        // The user types `const x`, accepts a completion to `const x = 123`, then deletes back
        // to `const x` (i.e., to the start of the original trigger). The original completion
        // should be reused.
        expect(
            await getInlineCompletions(params('const x█', [], { lastCandidate: lastCandidate('const x█', ' = 123') }))
        ).toEqual<V>({
            items: [{ insertText: ' = 123' }],
            source: InlineCompletionsResultSource.LastCandidate,
        }))

    test('not reused when deleting past the entire original trigger', async () =>
        // The user types `const x`, accepts a completion to `const x = 1`, then deletes back to
        // `const ` (i.e., *past* the start of the original trigger). The original ghost text
        // should not be reused.
        expect(
            await getInlineCompletions(
                params('const █', [], {
                    lastCandidate: lastCandidate('const x█', ' = 1'),
                })
            )
        ).toEqual<V>({
            items: [],
            source: InlineCompletionsResultSource.Network,
        }))

    test('not reused when the the next non-empty line has changed', async () => {
        // The user accepts a completion and then moves the cursor to the previous line and hits
        // enter again, causing a full suffix match with the previous completion that was
        // accepted before.
        const completions = await getInlineCompletions(
            params(
                dedent`
                    function foo() {
                        █
                        console.log()
                    }
                `,
                [],
                {
                    lastCandidate: lastCandidate(
                        dedent`
                        function foo() {
                            █
                        }
                    `,
                        'console.log()'
                    ),
                }
            )
        )

        expect(completions).toEqual<V>({
            items: [],
            source: InlineCompletionsResultSource.Network,
        })
    })

    test('not reused when deleting the entire non-whitespace line', async () =>
        // The user types `const x`, then deletes the entire line. The original ghost text
        // should not be reused.
        expect(
            await getInlineCompletions(
                params('█', [], {
                    lastCandidate: lastCandidate('const x█', ' = 1'),
                })
            )
        ).toEqual<V>({
            items: [],
            source: InlineCompletionsResultSource.Network,
        }))

    test('not reused when prefix changes', async () =>
        // The user types `x`, then deletes it, then types `y`. The original ghost text should
        // not be reused.
        expect(
            await getInlineCompletions(
                params('y█', [], {
                    lastCandidate: lastCandidate('x█', ' = 1'),
                })
            )
        ).toEqual<V>({
            items: [],
            source: InlineCompletionsResultSource.Network,
        }))

    test('filtered to only matching last-candidate items', async () =>
        // This behavior and test case is actually not needed for VS Code because it automatically
        // filters out items whose `insertText` does not prefix-match the replace range. (See
        // vscode.InlineCompletionItem.filterText for the docs about this.) But it is good to
        // perform this filtering anyway to avoid dependence on little-known VS Code behavior that
        // other consumers of this (via the agent) will likely not implement.
        expect(
            await getInlineCompletions(
                params('\nconsole.log("h█', [], {
                    lastCandidate: lastCandidate('\n█', ['console.log("Hi abc")', 'console.log("hi xyz")']),
                })
            )
        ).toEqual<V>({
            items: [{ insertText: 'i xyz")' }],
            source: InlineCompletionsResultSource.LastCandidate,
        }))

    describe('deleting leading whitespace', () => {
        const candidate = lastCandidate('\t\t█', 'const x = 1')

        test('reused when deleting some (not all) leading whitespace', async () =>
            // The user types on a new line `\t\t`, sees ghost text `const x = 1`, then
            // deletes one `\t`. The same ghost text should still be displayed.
            expect(await getInlineCompletions(params('\t█', [], { lastCandidate: candidate }))).toEqual<V>({
                items: [{ insertText: '\tconst x = 1' }],
                source: InlineCompletionsResultSource.LastCandidate,
            }))

        test('reused when deleting all leading whitespace', async () =>
            // The user types on a new line `\t\t`, sees ghost text `const x = 1`, then deletes
            // all leading whitespace (both `\t\t`). The same ghost text should still be
            // displayed.
            expect(await getInlineCompletions(params('█', [], { lastCandidate: candidate }))).toEqual<V>({
                items: [{ insertText: '\t\tconst x = 1' }],
                source: InlineCompletionsResultSource.LastCandidate,
            }))

        test('not reused when different leading whitespace is added at end of prefix', async () =>
            // The user types on a new line `\t\t`, sees ghost text `const x = 1`, then deletes
            // `\t` and adds ` ` (space). The same ghost text should not still be displayed.
            expect(await getInlineCompletions(params('\t █', [], { lastCandidate: candidate }))).toEqual<V>({
                items: [],
                source: InlineCompletionsResultSource.Network,
            }))

        test('not reused when different leading whitespace is added at start of prefix', async () =>
            // The user types on a new line `\t\t`, sees ghost text `const x = 1`, then deletes
            // `\t\t` and adds ` \t` (space). The same ghost text should not still be displayed.
            expect(await getInlineCompletions(params(' \t█', [], { lastCandidate: candidate }))).toEqual<V>({
                items: [],
                source: InlineCompletionsResultSource.Network,
            }))

        test('not reused when prefix replaced by different leading whitespace', async () =>
            // The user types on a new line `\t\t`, sees ghost text `const x = 1`, then deletes
            // `\t\t` and adds ` ` (space). The same ghost text should not still be displayed.
            expect(await getInlineCompletions(params(' █', [], { lastCandidate: candidate }))).toEqual<V>({
                items: [],
                source: InlineCompletionsResultSource.Network,
            }))
    })

    test('reused for a multi-line completion', async () =>
        // The user types ``, sees ghost text `x\ny`, then types ` ` (space). The original
        // completion should be reused.
        expect(await getInlineCompletions(params('x█', [], { lastCandidate: lastCandidate('█', 'x\ny') }))).toEqual<V>({
            items: [{ insertText: '\ny' }],
            source: InlineCompletionsResultSource.LastCandidate,
        }))

    test('reused when adding leading whitespace for a multi-line completion', async () =>
        // The user types ``, sees ghost text `x\ny`, then types ` `. The original completion
        // should be reused.
        expect(await getInlineCompletions(params(' █', [], { lastCandidate: lastCandidate('█', 'x\ny') }))).toEqual<V>({
            items: [{ insertText: 'x\ny' }],
            source: InlineCompletionsResultSource.LastCandidate,
        }))

    describe('completeSuggestWidgetSelection', () => {
        test('not reused when selected item info differs', async () =>
            // The user types `console`, sees the context menu pop up and receives a completion for
            // the first item. They now use the arrow keys to select the second item. The original
            // ghost text should not be reused as it won't be rendered anyways
            expect(
                await getInlineCompletions(
                    params('console█', [], {
                        lastCandidate: lastCandidate('console█', ' = 1', 'log'),
                        context: {
                            triggerKind: vsCodeMocks.InlineCompletionTriggerKind.Automatic,
                            selectedCompletionInfo: {
                                text: 'dir',
                                range: range(0, 0, 0, 0),
                            },
                        },
                        completeSuggestWidgetSelection: true,
                    })
                )
            ).toEqual<V>({
                items: [],
                source: InlineCompletionsResultSource.Network,
            }))
    })
})
