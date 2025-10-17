// This file is part of HFS - Copyright 2021-2023, Massimo Melina <a@rejetto.com> - License https://www.gnu.org/licenses/gpl-3.0.txt

import { Readable } from 'stream'
import bufferCrc32 from 'buffer-crc32'
const { unsigned } = bufferCrc32
import assert from 'assert'
import { try_ } from './misc'

const ZIP64_SIZE_LIMIT = 0xffffffff
const ZIP64_NUMBER_LIMIT = 0xffff

type Crc32Function = (input: string | Buffer, initialState?: number | undefined) => number
const crc32function: Crc32Function = try_(() => require('@node-rs/crc32').crc32 satisfies Crc32Function, () => {
    console.warn('using generic lib for crc32')
    return unsigned satisfies Crc32Function
})

const FLAGS = 0x0808 // bit3 = no crc in local header + bit11 = utf8

interface ZipSource {
    path: string
    sourcePath?: string
    getData?: () => Readable // deferred stream, so that we don't keep many open files because of calculateSize()
    size?: number
    ts?: Date
    mode?: number
}
interface QuickZipEntry {
    size: number,
    crc: number,
    ts: Date,
    pathAsBuffer: Buffer,
    offset: number,
    version: number,
    extAttr: number,
}
// the point of this class is the method applyRange, which allows seeking forward in the zip file quickly (useful to resume downloads)
export class QuickZipStream extends Readable {
    private workingFile: Readable | undefined
    private finished = false
    private readonly entries: QuickZipEntry[] = []
    private dataWritten = 0
    private consumedCalculating: ZipSource[] = []
    private skip: number = 0
    private limit?: number
    private now = new Date()

    constructor(private readonly walker:  AsyncIterableIterator<ZipSource>) {
        super({})
    }

    getArchiveEntries() {
        return this.entries.map(x => String(x.pathAsBuffer))
    }

    closeStream() {
        this.finished = true
        this.push(null) // EOF
    }

    continuePiping() {
        setImmediate(() => this.push('')) // stimulate the pipe. In some situations this needs to be done at next tick; not sure when, but maybe it's when we are inside a _read call that writes nothing
    }

    applyRange(start: number, end: number) {
        if (end < start)
            return this.closeStream()
        this.skip = start
        this.limit = end - start + 1
    }

    controlledPush(chunk: number[] | Buffer) {
        if (this.finished) return
        if (Array.isArray(chunk))
            chunk = buffer(chunk)
        this.dataWritten += chunk.length
        if (this.skip) {
            if (this.skip >= chunk.length) {
                this.skip -= chunk.length
                return true
            }
            chunk = chunk.subarray(this.skip)
            this.skip = 0
        }
        const lastBit = this.limit! < chunk.length
        if (lastBit)
            chunk = chunk.subarray(0, this.limit)

        const ret = this.push(chunk)
        if (lastBit)
            this.closeStream()
        return ret
    }

    async calculateSize(howLong:number = 1000) {
        const endBy = Date.now() + howLong
        for await (const value of this.walker) { // getting the entries is the slow part
            if (Date.now() >= endBy)
                return NaN
            this.consumedCalculating.push(value) // keep the same shape of the generator, so
        }
        // if we reach here, then we were able to consume all entries of the walker (in time)
        let offset = 0
        let centralDirSize = 0
        for (const file of this.consumedCalculating) {
            const pathSize = Buffer.from(file.path, 'utf8').length
            const { size=0, getData } = file
            const extraLength = (size > ZIP64_SIZE_LIMIT ? 2 : 0) + (offset > ZIP64_SIZE_LIMIT ? 1 : 0)
            const extraDataSize = extraLength && (2+2 + extraLength*8)
            offset += 4+2+2+2+ 4+4+4+4+ 2+2+ pathSize + size
            if (getData)
                offset += 4+4+2*(size > ZIP64_SIZE_LIMIT ? 8 : 4)
            centralDirSize += 4+2+2+2+2+ 4+4+4+4+ 2+2+2+2+2+ 4+4 + pathSize + extraDataSize
        }
        const n = this.consumedCalculating.length
        const centralDirOffset = offset
        if (n >= ZIP64_NUMBER_LIMIT
        || centralDirOffset >= ZIP64_SIZE_LIMIT
        || centralDirSize >= ZIP64_SIZE_LIMIT)
            centralDirSize += 4+8+2+2+4+4+8+8+8+8+4+4+8+4
        centralDirSize += 4+4+2+2+4+4+2
        return offset + centralDirSize
    }

    async _read() {
        if (this.finished || this.destroyed) return
        if (this.workingFile)
            return this.workingFile.resume()
        const file = this.consumedCalculating.shift()
            || (await this.walker.next()).value as ZipSource
        if (!file)
            return this.closeArchive()
        let { path, sourcePath, getData, size=0, ts=this.now, mode=0o40775 } = file
        const pathAsBuffer = Buffer.from(path, 'utf8')
        const offset = this.dataWritten
        const version = 20
        this.controlledPush([
            4, 0x04034b50,
            2, version,
            2, FLAGS,
            2, 0, // compression = store
            ...ts2buf(ts || this.now),
            // in our mode, crc and sizes are zero in local file header, and written in the data-descriptor after the file data, and in the central directory
            4, 0, // crc
            4, 0, // compressed size
            4, 0, // uncompressed size
            2, pathAsBuffer.length,
            2, 0, // length of the extra field
        ])
        this.controlledPush(pathAsBuffer)
        if (this.finished) return

        const cache = sourcePath ? crcCache[sourcePath] : undefined
        const cacheHit = Number(cache?.ts) === Number(ts)
        let crc = cacheHit ? cache!.crc : getData ? crc32function('') : 0
        const extAttr = !mode ? 0 : (mode | 0x8000) * 0x10000 // it's like <<16 but doesn't overflow so easily
        const entry = { size, crc, pathAsBuffer, ts, offset, version, extAttr }
        if (!getData) {
            this.entries.push(entry)
            return this.continuePiping()
        }
        if (this.skip >= size && cacheHit) {
            this.skip -= size
            this.dataWritten += size
            this.entries.push(entry)
        }
        else await new Promise<void>(resolve => {
            const data = this.workingFile = getData()
            data.on('error', (err) => {
                if ((err as any)?.code !== 'EACCES')
                    console.error('zipping:', String(err))
                data.destroy(err)
                resolve()
            })
            data.on('end', ()=>{
                entry.crc = crc
                if (sourcePath)
                    crcCache[sourcePath] = { ts, crc }
                this.entries.push(entry)
                resolve()
            })
            data.on('data', chunk => {
                if (this.destroyed)
                    return data.destroy()
                if (!this.controlledPush(chunk)) // destination buffer full
                    data.pause() // slow down
                if (!cacheHit)
                    crc = crc32function(chunk, crc)
                if (this.finished)
                    return data.destroy()
            })
        })
        this.workingFile = undefined
        const sizeForSize = size > ZIP64_SIZE_LIMIT ? 8 : 4
        if (this.controlledPush([
            4, 0x08074b50,
            4, entry.crc,
            sizeForSize, size,
            sizeForSize, size,
        ]))
            this.continuePiping()
    }

    closeArchive() {
        let centralDirOffset = this.dataWritten
        for (let { size, ts, crc, offset, pathAsBuffer, version, extAttr } of this.entries) {
            const extra = []
            if (size > ZIP64_SIZE_LIMIT) {
                extra.push(size, size)
                size = ZIP64_SIZE_LIMIT
            }
            if (offset > ZIP64_SIZE_LIMIT) {
                extra.push(offset)
                offset = ZIP64_SIZE_LIMIT
            }
            const extraData = buffer(!extra.length ? []
                : [ 2,1, 2,8*extra.length, ...extra.flatMap(x=> [8,x]) ])
            if (extraData.length && version < 45)
                version = 45
            this.controlledPush([
                4, 0x02014b50, // central dir signature
                2, version,
                2, version,
                2, FLAGS,
                2, 0,    // compression method = store
                ...ts2buf(ts),
                4, crc,
                4, size, // compressed
                4, size,
                2, pathAsBuffer.length,
                2, extraData.length,
                2, 0, //comment length
                2, 0, // disk
                2, 0, // attr
                4, extAttr,
                4, offset,
            ])
            this.controlledPush(pathAsBuffer)
            this.controlledPush(extraData)
        }
        const after = this.dataWritten
        let centralDirSize = after - centralDirOffset
        let n = this.entries.length
        if (n >= ZIP64_NUMBER_LIMIT
            || centralDirOffset >= ZIP64_SIZE_LIMIT
            || centralDirSize >= ZIP64_SIZE_LIMIT) {
            this.controlledPush([
                4, 0x06064b50, // end of central dir zip64
                8, 44,
                2, 45,
                2, 45,
                4, 0,
                4, 0,
                8, n,
                8, n,
                8, centralDirSize,
                8, centralDirOffset,
            ])
            this.controlledPush([
                4, 0x07064b50,
                4, 0,
                8, after,
                4, 1,
            ])
            centralDirOffset = ZIP64_SIZE_LIMIT
            centralDirSize = ZIP64_SIZE_LIMIT
            n = ZIP64_NUMBER_LIMIT
        }
        this.controlledPush([
            4, 0x06054b50, // end of central directory signature
            4, 0, // disk-related stuff
            2, n,
            2, n,
            4, centralDirSize,
            4, centralDirOffset,
            2, 0, // comment length
        ])
        this.closeStream()
    }
}

function buffer(pairs: number[]) {
    assert(pairs.length % 2 === 0)
    let total = 0
    for (let i=0; i < pairs.length; i+=2)
        total += pairs[i]!
    const ret = Buffer.alloc(total, 0)
    let offset = 0
    let i = 0
    while (i < pairs.length) {
        const size = pairs[i++]
        const data = pairs[i++]!
        if (size === 1)
            ret.writeUInt8(data, offset)
        else if (size === 2)
            ret.writeUInt16LE(data, offset)
        else if (size === 4)
            ret.writeUInt32LE(data, offset)
        else if (size === 8)
            ret.writeBigUInt64LE(BigInt(data), offset)
        else
            throw 'unsupported'
        offset += size
    }
    return ret
}

function ts2buf(ts:Date) {
    const date = ((ts.getFullYear() - 1980) & 0x7F) << 9 | (ts.getMonth() + 1) << 5 | ts.getDate()
    const time = ts.getHours() << 11 | ts.getMinutes() << 5 | (ts.getSeconds() / 2) & 0x0F
    return [
        2, time,
        2, date,
    ]
}

interface CrcCacheEntry { ts: Date, crc: number }
const crcCache: Record<string, CrcCacheEntry> = {}
