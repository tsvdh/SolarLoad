import axios from 'axios';
import Homey from 'homey';
import { Collection, MongoClient } from 'mongodb';
import * as SunCalc from 'suncalc';

type SunConditionMore = {
    duration: number;
    radiation: number;
}

type SunConditionBetween = {
    duration: number;
    radiationLow: number;
    radiationHigh: number;
}

type Measurement = {
    value: number;
    location: string;
    timestamp: Date;
}

class SolarDevice extends Homey.Device {

    // get value every minute, store values of last hour

    dataURL = 'https://www.weerzoetermeer.nl/clientraw/clientraw.txt';
    dbURI = `mongodb+srv://admin:${Homey.env.MONGO_PASSWORD}@cluster0.jwqp0hp.mongodb.net/?retryWrites=true&w=majority`

    lat = 52.061187262688705
    lng = 4.493821243730712

    solarCollection: Collection<Measurement> | undefined;

    measurementsCache: Measurement[] = [];

    timeFrames = [5, 10, 15, 30, 60];

    correctionPoints = new Map<number, number>([
        [5, 5],
        [10, 4],
        [15, 3],
        [20, 2.5],
        [25, 2],
        [45, 1.33],
    ]);

    getAverageValue(duration: number) : number {
        duration = Math.min(duration, this.measurementsCache.length);

        const wantedValues = this.measurementsCache.slice(0, duration);

        let average = wantedValues
            .map((measurement) => measurement.value)
            .reduce((accumulator, current) => accumulator + current);

        average /= duration;

        return average;
    }

    async addToDB(measurement: number) {
        await this.solarCollection!.insertOne({
            value: measurement,
            location: 'Zoetermeer',
            timestamp: new Date(),
        });
    }

    async getDBValues(): Promise<Measurement[]> {
        const documents = await this.solarCollection!.find({ location: 'Zoetermeer' }).toArray();
        return documents
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    }

    getCorrectionValue(angle: number): number {
        let minAngle = Number.MAX_SAFE_INTEGER;
        let maxAngle = Number.MIN_SAFE_INTEGER;

        this.correctionPoints.forEach((value, key) => {
            if (key < minAngle) {
                minAngle = key;
            }
            if (key > maxAngle) {
                maxAngle = key;
            }
        });

        let angleBelow = minAngle;
        let angleAbove = maxAngle;

        this.correctionPoints.forEach((value, key) => {
            if (key > angleBelow && key <= angle) {
                angleBelow = key;
            }
            if (key < angleAbove && key >= angle) {
                angleAbove = key;
            }
        });

        const belowMult = this.correctionPoints.get(angleBelow)!;
        const aboveMult = this.correctionPoints.get(angleAbove)!;

        const angleDiff = angleAbove - angleBelow;
        const ratio = angleDiff === 0 ? 0 : (angle - angleBelow) / angleDiff;

        this.log(ratio);

        return belowMult + ratio * (aboveMult - belowMult);
    }

    async refreshState(dataText: string) {
        let newValue = parseFloat(dataText.split(' ')[127]);

        if (Number.isNaN(newValue)) {
            return;
        }

        await this.setCapabilityValue('measure_luminance', newValue);

        let angleDegrees = SunCalc.getPosition(new Date(), this.lat, this.lng).altitude;
        angleDegrees *= 180 / Math.PI;
        angleDegrees = Math.max(0, angleDegrees);
        await this.setCapabilityValue('measure_wind_angle', angleDegrees);

        newValue *= this.getCorrectionValue(angleDegrees);
        await this.addToDB(newValue);
        await this.setCapabilityValue('measure_luminance.corrected', newValue);

        let azimuthDegrees = SunCalc.getPosition(new Date(), this.lat, this.lng).azimuth * (180 / Math.PI);
        // convert to suncalc website convention
        azimuthDegrees = (azimuthDegrees + 180) % 360;
        await this.setCapabilityValue('measure_gust_angle', azimuthDegrees);

        this.measurementsCache = await this.getDBValues();

        for (const timeFrame of this.timeFrames) {
            await this.setCapabilityValue(`measure_luminance.${timeFrame}min`, this.getAverageValue(timeFrame));
        }
    }

    /**
     * onInit is called when the device is initialized.
     */
    async onInit() {
        const options = {
            decimals: 0,
            units: 'W/m\u00B2',
        };

        await this.setCapabilityOptions('measure_luminance', {
            ...options,
            title: {
                en: 'Luminance now',
                nl: 'Helderheid nu',
            },
        });

        for (const timeFrame of this.timeFrames) {
            const id = `measure_luminance.${timeFrame}min`;
            await this.addCapability(id);

            await this.setCapabilityOptions(id, {
                ...options,
                title: {
                    en: `Luminance ${timeFrame} min`,
                    nl: `Helderheid ${timeFrame} min`,
                },
            });
        }

        await this.addCapability('measure_wind_angle');
        await this.setCapabilityOptions('measure_wind_angle', {
            decimals: 1,
            units: '\u00B0',
            title: {
                en: 'Sun angle',
                nl: 'Zon hoek',
            },
        });

        await this.addCapability('measure_luminance.corrected');
        await this.setCapabilityOptions('measure_luminance.corrected', {
            ...options,
            title: {
                en: 'Corrected luminance now',
                nl: 'Aangepaste helderheid nu',
            },
        });

        await this.addCapability('measure_gust_angle');
        await this.setCapabilityOptions('measure_gust_angle', {
            decimals: 0,
            units: '\u00B0',
            title: {
                en: 'Sun azimuth',
                nl: 'Zon azimut',
            },
        });

        this.log('Added capabilities');

        const client = new MongoClient(this.dbURI);
        await client.connect();

        const db = client.db('Measurements');
        await db.command({ ping: 1 });

        this.solarCollection = db.collection<Measurement>('Solar');

        this.log('Connected to DB');

        const updater = async () => {
            const res = await axios.get<string>(this.dataURL);
            await this.refreshState(res.data);
        };

        await updater();
        this.homey.setInterval(updater, 1000 * 60);

        this.log('Connected to data flow...');

        const sunConditionMore = this.homey.flow.getConditionCard('sun_more_less');
        sunConditionMore.registerRunListener(async (args: SunConditionMore) => {
            const average = this.getAverageValue(args.duration);

            return average > args.radiation;
        });

        const sunConditionBetween = this.homey.flow.getConditionCard('sun_range');
        sunConditionBetween.registerRunListener(async (args: SunConditionBetween) => {
            const average = this.getAverageValue(args.duration);

            return (args.radiationLow < average) && (average < args.radiationHigh);
        });

        this.log(`${this.getName()} has been initialized`);
    }

    /**
     * onAdded is called when the user adds the device, called just after pairing.
     */
    async onAdded() {
        this.log('MyDevice has been added');
    }

    /**
     * onSettings is called when the user updates the device's settings.
     * @param {object} event the onSettings event data
     * @param {object} event.oldSettings The old settings object
     * @param {object} event.newSettings The new settings object
     * @param {string[]} event.changedKeys An array of keys changed since the previous version
     * @returns {Promise<string|void>} return a custom message that will be displayed
     */
    async onSettings({
        oldSettings,
        newSettings,
        changedKeys,
    }: {
        oldSettings: { [key: string]: boolean | string | number | undefined | null };
        newSettings: { [key: string]: boolean | string | number | undefined | null };
        changedKeys: string[];
    }): Promise<string | void> {
        this.log('MyDevice settings where changed');
    }

    /**
     * onRenamed is called when the user updates the device's name.
     * This method can be used this to synchronise the name to the device.
     * @param {string} name The new name
     */
    async onRenamed(name: string) {
        this.log('MyDevice was renamed');
    }

    /**
     * onDeleted is called when the user deleted the device.
     */
    async onDeleted() {
        this.log('MyDevice has been deleted');
    }

}

module.exports = SolarDevice;
