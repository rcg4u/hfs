// This file is part of HFS - Copyright 2021-2023, Massimo Melina <a@rejetto.com> - License https://www.gnu.org/licenses/gpl-3.0.txt

import { createElement as h, DragEvent, Fragment, useMemo, useState, useEffect, CSSProperties } from 'react'
import { Btn, Flex, FlexV, iconBtn, Select } from './components'
import {
    basename, formatBytes, formatPerc, hIcon, useIsMobile, newDialog, selectFiles, working, copyTextToClipboard,
    HTTP_CONFLICT, formatSpeed, getHFS, onlyTruthy, cpuSpeedIndex, closeDialog, prefix, operationSuccessful, pathEncode,
} from './misc'
import _ from 'lodash'
import { INTERNAL_Snapshot, ref, useSnapshot } from 'valtio'
import { alertDialog, promptDialog } from './dialog'
import { reloadList } from './useFetchList'
import { apiCall } from '@hfs/shared/api'
import { state, useSnapState } from './state'
import { Link } from 'react-router-dom'
import { LinkClosingDialog } from './fileMenu'
import {
    abortCurrentUpload, enqueueUpload, getFilePath, normalizeAccept, resetCounters, resetReloadOnClose,
    simulateBrowserAccept, startUpload, ToUpload, uploadState
} from './uploadQueue'
import i18n from './i18n'
const { t } = i18n

const renameEnabled = getHFS().dontOverwriteUploading

export function showUpload() {
    if (!uploadState.qs.length)
        resetCounters()
    uploadState.uploadDialogIsOpen = true
    const { close } = newDialog({
        dialogProps: { id: 'upload-dialog', style: { minHeight: '6em', minWidth: 'min(20em, 100vw - 1em)' } },
        title: t`Upload`,
        icon: () => hIcon('upload'),
        Content,
        onClose() {
            uploadState.uploadDialogIsOpen = false
            if (resetReloadOnClose())
                reloadList()
        }
    })

    function clear() {
        uploadState.adding.splice(0,Infinity)
    }

    function Content(){
        const { qs, paused, eta, speed, adding } = useSnapshot(uploadState) as Readonly<typeof uploadState>
        const { props, uploadOnExisting } = useSnapState()
        const etaStr = useMemo(() => !eta || eta === Infinity ? '' : formatTime(eta*1000, 0, 2), [eta])
        const inQ = _.sumBy(qs, q => q.entries.length) - (uploadState.uploading ? 1 : 0)
        const queueStr = inQ && t('in_queue', { n: inQ }, "{n} in queue")
        const size = formatBytes(adding.reduce((a, x) => a + x.file.size, 0))
        const isMobile = useIsMobile()

        return h(FlexV, { gap: '.5em' },
            h(FlexV, { className: 'upload-toolbar' },
                props && !props.can_upload ? t('no_upload_here', "No upload permission for the current folder")
                    : h(FlexV, {},
                        h(Flex, { center: true, flexWrap: 'wrap', alignItems: 'stretch' },
                            h('button', {
                                className: 'upload-files',
                                onClick: () => pickFiles({ accept: normalizeAccept(props?.accept) })
                            }, t`Pick files`),
                            !isMobile && h('button', {
                                className: 'upload-folder',
                                onClick: () => pickFiles({ folder: true })
                            }, t`Pick folder`),
                            h('button', { className: 'create-folder', onClick: createFolder }, t`Create folder`),
                            h(Select<typeof uploadOnExisting>, {
                                style: { width: 'unset' },
                                'aria-label': t`Overwrite policy`,
                                value: uploadOnExisting || '',
                                onChange: v => state.uploadOnExisting = v,
                                options: onlyTruthy([
                                    { value: 'skip', label: t`Skip existing files` },
                                    renameEnabled && { value: 'rename', label: t`Rename to avoid overwriting` },
                                    props?.can_overwrite && { value: 'overwrite', label: t`Overwrite existing files` },
                                ])
                            }),
                        ),
                        !isMobile && h(Flex, { gap: 4 }, hIcon('info'), t('upload_dd_hint', "You can upload files doing drag&drop on the files list")),
                        h(UploadStatus, { margin: '.5em 0' }),
                        adding.length > 0 && h(Flex, { center: true, flexWrap: 'wrap' },
                            h('button', {
                                className: 'upload-send',
                                onClick() {
                                    void enqueueUpload(uploadState.adding)
                                    clear()
                                }
                            }, t('send_files', { n: adding.length, size }, "Send {n,plural,one{# file} other{# files}}, {size}")),
                            h('button', { onClick: clear }, t`Clear`),
                        )
                    ),
            ),
            h(FileList, {
                entries: uploadState.adding,
                actions: {
                    cancel: rec => _.remove(uploadState.adding, rec),
                    async comment(rec){
                        if (!props?.can_comment) return
                        const s = await inputComment(basename(rec.file.name), rec.comment)
                        if (s === undefined) return
                        rec.comment = s || undefined
                    },
                    async edit(rec) {
                        const was = rec.path
                        const s = await promptDialog(t('upload_name', "Upload with new name"), {
                            value: was,
                            onField: el => {
                                const ofs = was.lastIndexOf('/') + 1 // browsers picking a folder use / as separator even on Windows
                                const end = was.slice(ofs).lastIndexOf('.')
                                el.setSelectionRange(ofs, end < 0 ? was.length : ofs + end)
                            },
                        })
                        if (!s) return
                        rec.path = s
                    },
                },
            }),
            qs.length > 0 && h('div', {},
                h(Flex, { center: true, borderTop: '1px dashed', padding: '.5em' },
                    [etaStr, formatSpeed(speed), queueStr].filter(Boolean).join(', '),
                    inQ > 0 && iconBtn('delete', ()=>  {
                        uploadState.qs = []
                        abortCurrentUpload(true)
                    }, { title: t`Clear` }),
                    iconBtn(paused ? 'play' : 'pause', () => {
                        uploadState.paused = !uploadState.paused
                        if (uploadState.paused)
                            abortCurrentUpload()
                        else if (uploadState.uploading)
                            startUpload(uploadState.uploading, uploadState.qs[0].to)
                    }),
                ),
                qs.map((q,idx) =>
                    h('div', { key: q.to },
                        h(Link, { to: q.to, onClick: close }, t`Destination`, ' ', decodeURI(q.to)),
                        h(FileList, {
                            entries: uploadState.qs[idx].entries,
                            actions: {
                                cancel: f => {
                                    if (f === uploadState.uploading) {
                                        if (!uploadState.paused)
                                            return abortCurrentUpload(true)
                                        f.error = t`Interrupted`
                                        uploadState.skipped.push(f)
                                        uploadState.uploading = undefined
                                    }
                                    const q = uploadState.qs[idx]
                                    _.pull(q.entries, f)
                                    if (!q.entries.length)
                                        uploadState.qs.splice(idx,1)
                                }
                            }
                        }),
                    ))
            )
        )

        function pickFiles(options: Parameters<typeof selectFiles>[1]) {
            selectFiles(list => {
                uploadState.adding.push( ...Array.from(list || []).filter(simulateBrowserAccept)
                    .map(f => ({ file: ref(f), path: getFilePath(f) })) )
            }, options)
        }
    }

}

function FileList({ entries, actions }: { entries: ToUpload[], actions: { [icon:string]: null | ((rec :ToUpload) => any) } }) {
    const { uploading, progress, partial, hashing }  = useSnapshot(uploadState)
    const snapEntries = useSnapshot(entries)
    const [all, setAll] = useState(false)
    useEffect(() => setAll(false), [entries.length])
    const MAX = all ? Infinity : _.round(_.clamp(100 * cpuSpeedIndex, 10, 100))
    const rest = Math.max(0, snapEntries.length - MAX)
    const title = formatPerc(progress)
    return !snapEntries.length ? null : h('table', { className: 'upload-list', width: '100%' },
        h('tbody', {},
            snapEntries.slice(0, MAX).map((e, i) => {
                const working = e.file === uploading?.file // e is a proxy, so we check 'file' as it's a ref
                return h(Fragment, { key: i },
                    h('tr', {},
                        h('td', { className: 'nowrap '}, ..._.map(actions, (cb, icon) =>
                            cb && iconBtn(icon, () => cb(entries[i]), { className: `action-${icon}` })) ),
                        h('td', {}, formatBytes(e.file.size)),
                        h('td', {},
                            h('span', {}, e.path),
                            working && h('span', { className: 'upload-progress', title }, formatBytes(partial)),
                            working && hashing && h('span', { className: 'upload-hashing' }, t`Considering resume`, ' (', formatPerc(hashing), ')'),
                            working && h('progress', { className: 'upload-progress-bar', title, max: 1, value: _.round(progress, 3)  }), // round for fewer dom updates
                        ),
                    ),
                    e.comment && h('tr', {}, h('td', { colSpan: 3 }, h('div', { className: 'entry-comment' }, e.comment)) )
                )
            }),
            rest > 0 && h('tr', {}, h('td', { colSpan: 99 }, h('a', { href: '#', onClick: () => setAll(true) }, t('more_items', { n: rest }, "{n} more item(s)"))))
        )
    )
}

function formatTime(time: number, decimals=0, length=Infinity) {
    time /= 1000
    const ret = [(time % 1).toFixed(decimals).slice(1)]
    for (const [c,mod,pad] of [['s', 60, 2], ['m', 60, 2], ['h', 24], ['d', 36], ['y', 1 ]] as [string,number,number|undefined][]) {
        ret.push( _.padStart(String(time % mod | 0), pad || 0,'0') + c )
        time /= mod
        if (time < 1) break
    }
    return ret.slice(-length).reverse().join('')
}


export function UploadStatus({ snapshot, ...props }: { snapshot?: INTERNAL_Snapshot<typeof uploadState> } & CSSProperties) {
    const current = useSnapshot(uploadState)
    const { done, doneByte, errors, skipped } = snapshot || current
    const msgDone = done.length > 0 && t('upload_finished', { n: done.length, size: formatBytes(doneByte) }, "{n} finished ({size})")
    const msgSkipped = skipped.length > 0 && t('upload_skipped', { n: skipped.length }, "{n} skipped")
    const msgErrors = errors.length > 0 && t('upload_errors', { n: errors.length }, "{n} failed")
    const msg = [msgDone, msgSkipped, msgErrors].filter(Boolean).join(' – ')
    if (!msg) return null
    const sep = h('span', { className: 'horiz-sep' }, ' – ')
    return h('div', { style: { ...props } },
        msg, sep, h(Btn, { label: t`Show details`, asText: true, onClick: showDetails }),
        sep, h(Btn, {
            label: t('copy_links', "Copy links"),
            asText: true,
            successFeedback: true,
            onClick() {
                copyTextToClipboard(done.map(x => location.origin + x.response.uri).join('\n'))
                operationSuccessful()
            }
        }),
    )

    function showDetails() {
        if (!uploadState.uploadDialogIsOpen)
            closeDialog() // don't nest dialogs unnecessarily (apply only to the dialog outside upload-dialog)
        alertDialog(h('div', {},
            ([
                [msgDone, done],
                [msgSkipped, skipped],
                [msgErrors, errors]
            ] as const).map(([msg, list], i) =>
                msg && h('div', { key: i }, msg, h('ul', {},
                    list.map((x, i) =>
                        h('li', { key: i }, x.path, prefix(' (', x.error, ')'))
                )))
            )
        ))
    }
}

export function acceptDropFiles(cb: false | undefined | ((files:File[], to: string) => void)) {
    return {
        onDragOver(ev: DragEvent) {
            ev.preventDefault()
            ev.dataTransfer!.dropEffect = cb && ev.dataTransfer.types.includes('Files') ? 'copy' : 'none'
        },
        onDrop(ev: DragEvent) {
            ev.preventDefault()
            if (!cb) return
            for (const it of ev.dataTransfer.items) {
                const entry = it.webkitGetAsEntry()
                if (entry)
                    (function recur(entry: FileSystemEntry, to = '') {
                        if (entry.isFile)
                            (entry as FileSystemFileEntry).file(x => cb([x], x.webkitRelativePath ? '' : to)) // ff130 fills webkitRelativePath when dropping a folder, while chrome128 doesn't and we pass 'to' to preserve the structure
                        else (entry as FileSystemDirectoryEntry).createReader?.().readEntries(entries => {
                            const newTo = to + entry.name + '/'
                            for (const e of entries)
                                recur(e, newTo)
                        })
                    })(entry)
            }
        },
    }
}

export async function createFolder() {
    const name = await promptDialog(t`Enter folder name`)
    if (!name) return
    const uri = location.pathname
    try {
        await apiCall('create_folder', { uri, name }, { modal: working })
        reloadList()
        await alertDialog(h(() =>
            h(FlexV, {},
                h('div', {}, t`Successfully created`),
                h(LinkClosingDialog, { to: uri + pathEncode(name) + '/' }, t('enter_folder', "Enter the folder")),
            )))
    }
    catch(e: any) {
        await alertDialog(e.code === HTTP_CONFLICT ? t('folder_exists', "Folder with same name already exists") : e)
    }
}

export function inputComment(filename: string, value?: string) {
    return promptDialog(t('enter_comment', { name: filename }, "Comment for {name}"), { value, type: 'textarea' })
}