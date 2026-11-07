
export enum ETrackingEvent {
    LOADING = 'LOADING',
    LOADED = 'LOADED',
    DISPLAYED = 'DISPLAYED',
    CHALLENGE_STARTED = 'CHALLENGE_STARTED',
    CHALLENGE_FAILED = 'CHALLENGE_FAILED',
    CHALLENGE_RETRY = 'CHALLENGE_RETRY',
    CHALLENGE_PASS_25 = 'CHALLENGE_PASS_25',
    CHALLENGE_PASS_50 = 'CHALLENGE_PASS_50',
    CHALLENGE_PASS_75 = 'CHALLENGE_PASS_75',
    CHALLENGE_SOLVED = 'CHALLENGE_SOLVED',
    COMPLETED = 'COMPLETED',
    CTA_CLICKED = 'CTA_CLICKED',
    ENDCARD_SHOWN = 'ENDCARD_SHOWN',
}

export class TrackingManager {
    static TrackEvent(nameEvent: string) {

        if (EDITOR)
        {
            console.log("Tracking Event:", nameEvent);
        }

        //@ts-ignore
        if (typeof window.ALPlayableAnalytics != 'undefined') {
            //@ts-ignore
            window.ALPlayableAnalytics.trackEvent(nameEvent);
        }
    }
}
