type Constructor<T> = new (...args: any[]) => T;

export class ServiceLocator {
    private static services = new Map<Constructor<any>, any>();

    static register<T>(type: Constructor<T>, instance: T) {
        this.services.set(type, instance);
    }

    static get<T>(type: Constructor<T>): T {
        if (!this.services.has(type)) {
            this.services.set(type, new type());
        }

        return this.services.get(type);
    }
}