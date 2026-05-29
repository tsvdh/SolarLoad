import Homey from 'homey';
import { Collection, MongoClient } from 'mongodb';
// import * as https from 'node:https';
import * as SunCalc from 'suncalc';
// eslint-disable-next-line import/extensions,import/no-unresolved,node/no-missing-import,object-curly-newline
import { CorrectedSolarSource, SolarPanels, SolarSourceStatus, WeerZoetermeer, ZoeterWeer } from './solar_source';

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

    dbURI = `mongodb+srv://admin:${Homey.env.MONGO_PASSWORD}@cluster0.jwqp0hp.mongodb.net/?retryWrites=true&w=majority`;

    solarSources = new Map<string, CorrectedSolarSource>();

    lat = 52.061187262688705;
    lng = 4.493821243730712;

    solarCollection: Collection<Measurement> | undefined;
    solarPanelCollection: Collection<Measurement> | undefined;

    measurementsCache: Measurement[] = [];

    timeFrames = [5, 10, 15, 30, 60];

    getAverageCacheValue(duration: number) : number {
        duration = Math.min(duration, this.measurementsCache.length);

        const wantedValues = this.measurementsCache.slice(0, duration);

        let average = wantedValues
            .map((measurement) => measurement.value)
            .reduce((accumulator, current) => accumulator + current);

        average /= duration;

        return average;
    }

    async addToSolarCollection(measurement: number) {
        await this.solarCollection!.insertOne({
            value: measurement,
            location: 'Zoetermeer',
            timestamp: new Date(),
        });
    }

    async getSolarCollectionValues(): Promise<Measurement[]> {
        const documents = await this.solarCollection!.find({ location: 'Zoetermeer' }).toArray();
        return documents
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    }

    async refreshState() {
        let angleDegrees = SunCalc.getPosition(new Date(), this.lat, this.lng).altitude;
        angleDegrees *= 180 / Math.PI;
        angleDegrees = Math.max(0, angleDegrees);
        await this.setCapabilityValue('measure_wind_angle', angleDegrees);

        let azimuthDegrees = SunCalc.getPosition(new Date(), this.lat, this.lng).azimuth * (180 / Math.PI);
        // convert to suncalc website convention
        azimuthDegrees = (azimuthDegrees + 180) % 360;
        await this.setCapabilityValue('measure_gust_angle', azimuthDegrees);

        let finalValue = 0;
        for (const name of ['SolarPanels', 'WeerZoetermeer', 'ZoeterWeer']) {
            const res = await this.solarSources.get(name)!.getAndCheckCorrectedLoad();

            const isError = res[0] === SolarSourceStatus.Error;
            await this.setCapabilityValue(`alarm_generic.${name}`, isError);

            await this.setCapabilityValue(`measure_luminance.${name}_actual`, res[1]);
            await this.setCapabilityValue(`measure_luminance.${name}_corrected`, res[2]);

            await this.setCapabilityValue(`measure_power.${name}`, Number(isError));

            if (!isError) {
                finalValue = res[2];
            }
        }

        await this.addToSolarCollection(finalValue);
        await this.setCapabilityValue('measure_luminance.final', finalValue);

        this.measurementsCache = await this.getSolarCollectionValues();

        for (const timeFrame of this.timeFrames) {
            await this.setCapabilityValue(`measure_luminance.${timeFrame}min`, this.getAverageCacheValue(timeFrame));
        }
    }

    solarSourceNameToLang(name: string) {
        let nameEn = name;
        let nameNl = name;
        if (name === 'SolarPanels') {
            nameEn = 'Solar Panels';
            nameNl = 'Zonnepanelen';
        }
        return [nameEn, nameNl];
    }

    /**
     * onInit is called when the device is initialized.
     */
    async onInit() {
        // for (const name of this.getCapabilities()) {
        //     await this.removeCapability(name);
        // }

        const options = {
            decimals: 0,
            units: 'W/m\u00B2',
        };

        await this.addCapability('measure_luminance.final');
        await this.setCapabilityOptions('measure_luminance.final', {
            ...options,
            title: {
                en: 'Final radiance now',
                nl: 'Uiteindelijke straling nu',
            },
        });

        for (const name of ['SolarPanels', 'WeerZoetermeer', 'ZoeterWeer']) {
            for (const type of ['actual', 'corrected']) {
                const [nameEn, nameNl] = this.solarSourceNameToLang(name);
                const typeNl: string = type === 'actual' ? 'echt' : 'corrigeerd';

                const id = `measure_luminance.${name}_${type}`;
                await this.addCapability(id);

                await this.setCapabilityOptions(id, {
                    ...options,
                    title: {
                        en: `Radiance ${nameEn} ${type}`,
                        nl: `Straling ${nameNl} ${typeNl}`,
                    },
                    uiComponent: null,
                });
            }
        }

        for (const timeFrame of this.timeFrames) {
            const id = `measure_luminance.${timeFrame}min`;
            await this.addCapability(id);

            await this.setCapabilityOptions(id, {
                ...options,
                title: {
                    en: `Radiance ${timeFrame} min`,
                    nl: `Straling ${timeFrame} min`,
                },
                uiComponent: null,
            });
        }

        for (const name of ['SolarPanels', 'WeerZoetermeer', 'ZoeterWeer']) {
            const [nameEn, nameNl] = this.solarSourceNameToLang(name);

            await this.addCapability(`alarm_generic.${name}`);
            await this.setCapabilityOptions(`alarm_generic.${name}`, {
                title: {
                    en: `${nameEn} status`,
                    nl: `${nameNl} status`,
                },
            });

            await this.addCapability(`measure_power.${name}`);
            await this.setCapabilityOptions(`measure_power.${name}`, {
                units: 'Y/N',
                decimals: 0,
                min: 0,
                max: 1,
                step: 1,
                title: {
                    en: `${name === 'SolarPanels' ? nameEn : name} status number`,
                    nl: `${name === 'SolarPanels' ? nameNl : name} status number`,
                },
                uiComponent: null,
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

        const measurementsDB = client.db('Measurements');
        await measurementsDB.command({ ping: 1 });

        this.solarCollection = measurementsDB.collection<Measurement>('Solar');
        this.solarPanelCollection = measurementsDB.collection<Measurement>('SolarPanels');

        this.log('Connected to DB');

        this.solarSources = new Map([
            ['WeerZoetermeer', new WeerZoetermeer(this) as CorrectedSolarSource],
            ['ZoeterWeer', new ZoeterWeer(this) as CorrectedSolarSource],
            ['SolarPanels', new SolarPanels(this, this.solarPanelCollection) as CorrectedSolarSource],
        ]);

        const updater = async () => {
            await this.refreshState();
        };

        await updater();
        this.homey.setInterval(updater, 1000 * 60);

        this.log('Connected to data flow...');

        const sunConditionMore = this.homey.flow.getConditionCard('sun_more_less');
        sunConditionMore.registerRunListener(async (args: SunConditionMore) => {
            const average = this.getAverageCacheValue(args.duration);

            return average > args.radiation;
        });

        const sunConditionBetween = this.homey.flow.getConditionCard('sun_range');
        sunConditionBetween.registerRunListener(async (args: SunConditionBetween) => {
            const average = this.getAverageCacheValue(args.duration);

            return (args.radiationLow < average) && (average < args.radiationHigh);
        });

        const setPower = this.homey.flow.getActionCard('set-power');
        setPower.registerRunListener(async (value) => {
            const measurement = parseInt(value.watt, 10);
            await this.solarPanelCollection!.insertOne({
                value: measurement,
                location: 'Tweede Stationsstraat',
                timestamp: new Date(),
            });
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
