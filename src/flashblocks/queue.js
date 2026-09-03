'use strict'

class BoundedEventQueue {
    constructor(maxSize) {
        this.maxSize = maxSize
        this.items = []
        this.waiters = []
        this.dropped = 0
    }

    push(item) {
        if (this.waiters.length) return this.waiters.shift()(item)
        if (this.items.length >= this.maxSize) {
            this.items.shift()
            this.dropped += 1
        }
        this.items.push(item)
    }

    async pop() {
        if (this.items.length) return this.items.shift()
        return new Promise(resolve => this.waiters.push(resolve))
    }

    get length() { return this.items.length }
}

module.exports = { BoundedEventQueue }
