import axios from 'axios';
import Homey from 'homey';
import { Collection, MongoClient } from 'mongodb';

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

    solarCollection: Collection<Measurement> | undefined;

    measurementsCache: Measurement[] = [];

    timeFrames = [5, 10, 15, 30, 60];

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

    async refreshState(dataText: string) {
        const newValue = parseFloat(dataText.split(' ')[127]);

        if (Number.isNaN(newValue)) {
            return;
        }

        await this.addToDB(newValue);

        this.measurementsCache = await this.getDBValues();

        await this.setCapabilityValue('measure_luminance', newValue);

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
            const average = await this.getAverageValue(args.duration);

            return average > args.radiation;
        });

        const sunConditionBetween = this.homey.flow.getConditionCard('sun_range');
        sunConditionBetween.registerRunListener(async (args: SunConditionBetween) => {
            const average = await this.getAverageValue(args.duration);

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
