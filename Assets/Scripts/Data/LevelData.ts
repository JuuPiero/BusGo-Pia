import { field, JsonAsset, serializable, Vector2 } from "@pia/core";

@serializable
export class RetryColorShuffleData {
    after_retries: number = 0;
    interval: number = 0;
}

@serializable
export class VehicleData {
    id: number = -1;
    kind: string = '';
    color: number = 0;
    seats: number = 0;
    @field(Vector2) pos: Vector2 = new Vector2();
    rot_y: number = 0;
    rotates: boolean = false;
    mystery: boolean = false;
}

@serializable
export class GarageCarData {
    id: number = -1;
    color: number = 0;
    seats: number = 0;
}

@serializable
export class GimmickData {
    type: string = '';
    id: number = 0;
    @field(Vector2) pos: Vector2 = new Vector2();
    rot_y: number = 0;
    @field([GarageCarData]) cars: GarageCarData[] = [];
}

@serializable
export class PassengerGroupData {
    color: number = 0;
    count: number = 0;
}

@serializable
export class PassengerData {
    loop_model: string = '';
    rotation: string = '';
    @field([PassengerGroupData]) left: PassengerGroupData[] = [];
    @field([PassengerGroupData]) right: PassengerGroupData[] = [];
    /** Mọi level hiện tại để null. Object sau này được lưu dạng JSON text. */
    gate: string = '';
}

@serializable
export class CarLayerData {
    carId: number = 0;
    layer: number = 0;
}

@serializable
export class BlockedByData {
    carId: number = 0;
    blockers: number[] = [];
}

@serializable
export class AnalysisData {
    depth: number = 0;
    stuck: number = 0;
    @field([CarLayerData]) layer: CarLayerData[] = [];
    @field([BlockedByData]) blocked_by: BlockedByData[] = [];
    seats_match_passengers: boolean = false;
}
@serializable
export class LevelData {
    format: string = '';
    id: number = 0;
    revision: number = 0;
    name: string = '';
    difficulty: string = '';
    @field(Vector2) bounds_W: Vector2 = new Vector2();
    @field(RetryColorShuffleData) retry_color_shuffle: RetryColorShuffleData = new RetryColorShuffleData();
    @field([VehicleData]) cars: VehicleData[] = [];
    @field([GimmickData]) gimmicks: GimmickData[] = [];
    @field(PassengerData) passengers: PassengerData = new PassengerData();
    @field(AnalysisData) analysis: AnalysisData = new AnalysisData();

    /** Đọc một file level (format "busgo.unity/2"). Field thiếu trong file giữ giá trị mặc định. */
    public static Parse(json: JsonAsset): LevelData {
        const raw = json.json as RawObject | undefined;
        if (!raw || typeof raw !== 'object') throw new Error(`${json.path}: level chưa được nạp hoặc không phải object JSON`);

        const level = new LevelData();
        level.format = str(raw.format);
        level.id = num(raw.id);
        level.revision = num(raw.revision);
        level.name = str(raw.name);
        level.difficulty = str(raw.difficulty);
        level.bounds_W = vec2(raw.bounds_W);

        const shuffle = obj(raw.retry_color_shuffle);
        level.retry_color_shuffle.after_retries = num(shuffle.after_retries);
        level.retry_color_shuffle.interval = num(shuffle.interval);

        level.cars = arr(raw.cars).map((v) => {
            const c = obj(v);
            const car = new VehicleData();
            car.id = num(c.id, -1);
            car.kind = str(c.kind);
            car.color = num(c.color);
            car.seats = num(c.seats);
            car.pos = vec2(c.pos);
            car.rot_y = num(c.rot_y);
            car.rotates = bool(c.rotates);
            car.mystery = bool(c.mystery);
            return car;
        });

        level.gimmicks = arr(raw.gimmicks).map((v) => {
            const g = obj(v);
            const gimmick = new GimmickData();
            gimmick.type = str(g.type);
            gimmick.id = num(g.id);
            gimmick.pos = vec2(g.pos);
            gimmick.rot_y = num(g.rot_y);
            gimmick.cars = arr(g.cars).map((cv) => {
                const c = obj(cv);
                const car = new GarageCarData();
                car.id = num(c.id, -1);
                car.color = num(c.color);
                car.seats = num(c.seats);
                return car;
            });
            return gimmick;
        });

        // "left" / "right": mảng các cặp [màu, số khách]
        const p = obj(raw.passengers);
        const groups = (v: unknown) =>
            arr(v).map((pair) => {
                const g = new PassengerGroupData();
                const [color, count] = arr(pair);
                g.color = num(color);
                g.count = num(count);
                return g;
            });
        level.passengers.loop_model = str(p.loop_model);
        level.passengers.rotation = str(p.rotation);
        level.passengers.left = groups(p.left);
        level.passengers.right = groups(p.right);
        level.passengers.gate = p.gate == null ? '' : typeof p.gate === 'string' ? p.gate : JSON.stringify(p.gate);

        // "layer" / "blocked_by": object theo id xe → mảng phần tử { carId, ... }, sắp theo id
        const a = obj(raw.analysis);
        level.analysis.depth = num(a.depth);
        level.analysis.stuck = num(a.stuck);
        level.analysis.layer = byCarId(a.layer).map(([carId, v]) => {
            const l = new CarLayerData();
            l.carId = carId;
            l.layer = num(v);
            return l;
        });
        level.analysis.blocked_by = byCarId(a.blocked_by).map(([carId, v]) => {
            const b = new BlockedByData();
            b.carId = carId;
            b.blockers = arr(v).map((x) => num(x));
            return b;
        });
        level.analysis.seats_match_passengers = bool(a.seats_match_passengers);
        return level;
    }
}

// ---------------------------------------------------------------- đọc giá trị JSON an toàn

type RawObject = Record<string, unknown>;

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const bool = (v: unknown): boolean => v === true;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): RawObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as RawObject) : {});
/** [x, y] → Vector2 */
const vec2 = (v: unknown): Vector2 => {
    const [x, y] = arr(v);
    return new Vector2(num(x), num(y));
};
/** { "3": a, "12": b } → [[3, a], [12, b]] (sắp theo id) */
const byCarId = (v: unknown): [number, unknown][] =>
    Object.entries(obj(v))
        .map(([k, x]): [number, unknown] => [Number(k), x])
        .filter(([k]) => Number.isFinite(k))
        .sort((p, q) => p[0] - q[0]);