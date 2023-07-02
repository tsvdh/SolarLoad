import axios from 'axios';
import Homey from 'homey';

type SunConditionMore = {
    duration: number;
    radiation: number;
}

type SunConditionBetween = {
    duration: number;
    radiationLow: number;
    radiationHigh: number;
}

class SolarDevice extends Homey.Device {

    // get value every minute, store values of last hour

    dataURL = 'https://www.weerzoetermeer.nl/clientraw/clientraw.txt';
    values: number[] = [];

    timeFrames = [5, 10, 15, 30, 60];

    getAverageValue(duration: number) : number | null {
        duration = Math.min(duration, this.values.length);

        if (duration === 0) {
            return null;
        }

        const wantedValues = this.values.slice(0, duration);

        let average = wantedValues.reduce((accumulator, current) => {
            return accumulator + current;
        });

        average /= duration;

        return average;
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

        const getData = async () => {
            const rawData = await axios.get<string>(this.dataURL).then((res) => res.data);

            const newValue = parseFloat(rawData.split(' ')[127]);

            this.values.unshift(newValue);
            if (this.values.length > 60) {
                this.values.pop();
            }

            await this.setCapabilityValue('measure_luminance', newValue);

            for (const timeFrame of this.timeFrames) {
                if (timeFrame <= this.values.length) {
                    await this.setCapabilityValue(`measure_luminance.${timeFrame}min`, this.getAverageValue(timeFrame));
                }
            }
        };

        await getData();
        this.homey.setInterval(getData, 1000 * 60);

        this.log('Connected to data flow...');

        const sunConditionMore = this.homey.flow.getConditionCard('sun_more_less');
        sunConditionMore.registerRunListener((args: SunConditionMore) => {
            const average = this.getAverageValue(args.duration);

            return average == null
                ? false
                : average > args.radiation;
        });

        const sunConditionBetween = this.homey.flow.getConditionCard('sun_range');
        sunConditionBetween.registerRunListener((args: SunConditionBetween) => {
            const average = this.getAverageValue(args.duration);

            return average == null
                ? false
                : (args.radiationLow < average) && (average < args.radiationHigh);
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
