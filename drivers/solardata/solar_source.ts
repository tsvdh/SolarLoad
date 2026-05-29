// eslint-disable-next-line max-classes-per-file
import axios from 'axios';
import Homey from 'homey';
import { Collection } from 'mongodb';
import * as https from 'node:https';

type Measurement = {
    value: number;
    location: string;
    timestamp: Date;
}

export enum SolarSourceStatus {
    Ok,
    Error,
}

export abstract class SolarSource {

    protected device: Homey.Device;

    private cacheSize = 30;
    private loadCache: number[] = [];

    protected constructor(device: Homey.Device) {
        this.device = device;
    }

    abstract getLoad(): Promise<[SolarSourceStatus, number]>;

    async getAndCheckLoad(): Promise<[SolarSourceStatus, number]> {
        const load = await this.getLoad();
        if (load[0] === SolarSourceStatus.Error) {
            this.loadCache = [];
            return load;
        }

        const sunAngle = parseFloat(this.device.getCapabilityValue('measure_wind_angle'));
        if (sunAngle > 7 && load[1] === 0) {
            return [SolarSourceStatus.Error, 0];
        }

        this.loadCache.push(load[1]);
        if (this.loadCache.length > this.cacheSize) {
            this.loadCache.shift();
        }

        // this.device.log(this.loadCache);

        const cacheSet: Set<number> = new Set();
        for (const val of this.loadCache) {
            cacheSet.add(val);
        }
        if (this.loadCache.length === this.cacheSize && cacheSet.size === 1 && !cacheSet.has(0)) {
            return [SolarSourceStatus.Error, 0];
        }

        return load;
    }

}

export abstract class CorrectedSolarSource extends SolarSource {

    async getAndCheckCorrectedLoad(): Promise<[SolarSourceStatus, number, number]> {
        const checkedLoad = await super.getAndCheckLoad();

        if (checkedLoad[0] === SolarSourceStatus.Error) {
            return [checkedLoad[0], checkedLoad[1], 0];
        }

        const angle = parseFloat(this.device.getCapabilityValue('measure_wind_angle'));
        const correctedLoad = checkedLoad[1] * this.getCorrectionValue(angle);

        return [checkedLoad[0], checkedLoad[1], correctedLoad];
    }

    protected abstract getCorrectionPoints(): Map<number, number>;

    private getCorrectionValue(angle: number): number {
        const correctionPoints = this.getCorrectionPoints();

        let minAngle = Number.MAX_SAFE_INTEGER;
        let maxAngle = Number.MIN_SAFE_INTEGER;

        correctionPoints.forEach((value, key) => {
            if (key < minAngle) {
                minAngle = key;
            }
            if (key > maxAngle) {
                maxAngle = key;
            }
        });

        let angleBelow = minAngle;
        let angleAbove = maxAngle;

        correctionPoints.forEach((value, key) => {
            if (key > angleBelow && key <= angle) {
                angleBelow = key;
            }
            if (key < angleAbove && key >= angle) {
                angleAbove = key;
            }
        });

        const belowMult = correctionPoints.get(angleBelow)!;
        const aboveMult = correctionPoints.get(angleAbove)!;

        const angleDiff = angleAbove - angleBelow;
        const ratio = angleDiff === 0 ? 0 : (angle - angleBelow) / angleDiff;

        return belowMult + ratio * (aboveMult - belowMult);
    }

}

export abstract class WeatherStation extends CorrectedSolarSource {

    private correctionPoints = new Map<number, number>([
        [5, 4],
        [10, 3.5],
        [15, 3],
        [20, 2.5],
        [25, 2],
        [45, 1],
    ]);

    protected getCorrectionPoints(): Map<number, number> {
        return this.correctionPoints;
    }

}

export class ZoeterWeer extends WeatherStation {

    private dataURL = 'https://www.zoeterweer.nl/test/downld02.txt';

    constructor(device: Homey.Device) {
        super(device);

        axios.defaults.httpsAgent = new https.Agent({
            rejectUnauthorized: false,
        });

        this.device.log('Axios agent has "rejectUnauthorized" disabled');
    }

    async getLoad(): Promise<[SolarSourceStatus, number]> {
        let res;
        try {
            res = await axios.get<string>(this.dataURL, { timeout: 10000 });
        } catch {
            return [SolarSourceStatus.Error, 0];
        }

        const measureMoments = res.data.split('\n');
        const latestMoment = measureMoments[measureMoments.length - 2];

        const value = parseInt(
            latestMoment
                .split(' ')
                .filter((el) => el !== '')
                .at(19)!,
            10,
        );

        return Number.isNaN(value)
            ? [SolarSourceStatus.Error, 0]
            : [SolarSourceStatus.Ok, value];
    }

}

export class WeerZoetermeer extends WeatherStation {

    private dataURL = 'https://www.weerzoetermeer.nl/clientraw/clientraw.txt';

    // eslint-disable-next-line no-useless-constructor
    constructor(device: Homey.Device) {
        super(device);
    }

    async getLoad(): Promise<[SolarSourceStatus, number]> {
        let res;
        try {
            res = await axios.get<string>(this.dataURL, { timeout: 10000 });
        } catch {
            return [SolarSourceStatus.Error, 0];
        }

        const value = parseInt(res.data.split(' ')[127], 10);

        return Number.isNaN(value)
            ? [SolarSourceStatus.Error, 0]
            : [SolarSourceStatus.Ok, value];
    }

}

export class SolarPanels extends CorrectedSolarSource {

    private solarPanelCollection: Collection<Measurement>;

    private correctionPoints = new Map<number, number>([
        [5, 4],
        [10, 3.5],
        [15, 3],
        [20, 2.5],
        [25, 2],
        [45, 1],
    ]);

    protected getCorrectionPoints(): Map<number, number> {
        return this.correctionPoints;
    }

    constructor(device: Homey.Device, solarPanelCollection: Collection<Measurement>) {
        super(device);
        this.solarPanelCollection = solarPanelCollection;
    }

    async getLoad(): Promise<[SolarSourceStatus, number]> {
        const latestMeasurement = await this.solarPanelCollection.find().sort({ timestamp: -1 }).next();
        if (!latestMeasurement) {
            return [SolarSourceStatus.Error, 0];
        }

        const normalizer = 870 / 3500;
        return [SolarSourceStatus.Ok, Math.floor(latestMeasurement.value * normalizer)];
    }

}
