import Homey from 'homey';
import axios from 'axios';

type SunCondition = {
    duration: number;
    radiation: number;
}

class App extends Homey.App {

    // get value every minute, store values of last hour

    dataURL = 'https://www.weerzoetermeer.nl/clientraw/clientraw.txt';
    values: number[] = [];

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
            this.log(this.values);
        }, 1000 * 60);

        this.log('Capturing data flow');

        const sunCondition = this.homey.flow.getConditionCard('sun_zoetermeer');
        sunCondition.registerRunListener((args: SunCondition, state) => {
            const wantedValues = this.values.slice(0, args.duration);

            let average = wantedValues.reduce((accumulator, current) => {
                return accumulator + current;
            });

            average /= args.duration;

            return average > args.radiation;
        });

        this.log('Solar Load initialized');
    }

}

module.exports = App;
