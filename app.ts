import Homey from 'homey';
import axios from 'axios';

type SunConditionMore = {
    duration: number;
    radiation: number;
}

type SunConditionBetween = {
    duration: number;
    radiationLow: number;
    radiationHigh: number;
}

class App extends Homey.App {

    // get value every minute, store values of last hour

    dataURL = 'https://www.weerzoetermeer.nl/clientraw/clientraw.txt';
    values: number[] = [];

    getAverageValue(duration: number) {
        const wantedValues = this.values.slice(0, duration);

        let average = wantedValues.reduce((accumulator, current) => {
            return accumulator + current;
        });

        average /= duration;

        return average;
    }

    /**
    * onInit is called when the app is initialized.
    */
    async onInit() {
        this.log('Solar Load starting');

        this.homey.setInterval(async () => {
            const rawData = await axios.get<string>(this.dataURL).then((res) => res.data);

            this.values.unshift(parseFloat(rawData.split(' ')[127]));
            if (this.values.length > 60) {
                this.values.pop();
            }
        }, 1000 * 60);

        this.log('Capturing data flow...');

        const sunConditionMore = this.homey.flow.getConditionCard('sun_zoetermeer_more_less');
        sunConditionMore.registerRunListener((args: SunConditionMore, state) => {
            const average = this.getAverageValue(args.duration);

            return average > args.radiation;
        });

        const sunConditionBetween = this.homey.flow.getConditionCard('sun_zoetermeer_range');
        sunConditionBetween.registerRunListener((args: SunConditionBetween, state) => {
            const average = this.getAverageValue(args.duration);

            return (args.radiationLow < average) && (average < args.radiationHigh);
        });

        this.log('Solar Load initialized');
    }

}

module.exports = App;
