import { Debug } from "@pia/core";

export class EventBus {

    private static events = new Map<string, Function[]>();

    static on(event: string, cb: Function) {
        if (!this.events.has(event)) {
            this.events.set(event, []);
        }

        this.events.get(event)!.push(cb);
    }

    static off(event: string, cb: Function) {
        const arr = this.events.get(event);
        if (!arr) return;

        const index = arr.indexOf(cb);
        if (index !== -1) arr.splice(index, 1);
    }

    static emit(event: string, ...args: any) {
        const arr = this.events.get(event);
        if (!arr) return;

        arr.forEach(cb => cb(...args));
        if(EDITOR) {
            Debug.log("Raise event: " + event);
        }
    }
}
