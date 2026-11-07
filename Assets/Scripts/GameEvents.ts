export const GameEvents = {
    NEW_GAME: "NEW_GAME",
    WIN_GAME: "WIN_GAME",
    LOSE_GAME: "LOSE_GAME",
    /** (vehicle: Vehicle, clickPoint: Vec3 world point where the click hit the vehicle) */
    CAR_CLICK: "CAR_CLICK",
    VEHICLE_PARKED: "VEHICLE_PARKED",
    VEHICLE_DEPARTED: "VEHICLE_DEPARTED",
    VEHICLE_COMPLTED: "VEHICLE_COMPLTED",

    /**
     * A blocked vehicle's nose touches the vehicle in front, or two driving vehicles
     * bump into each other: (contactPoint: Vec3, vehicle: Vehicle, other: Vehicle).
     */
    VEHICLE_HIT: "VEHICLE_HIT",
    /** A tapped vehicle starts driving to its slot: (vehicle: Vehicle, tailDistance: number from its centre to the tail). */
    VEHICLE_MOVE_START: "VEHICLE_MOVE_START",
}
