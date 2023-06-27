import Homey from 'homey';

class SolarLoad extends Homey.App {

    /**
    * onInit is called when the app is initialized.
    */
    async onInit() {
        this.log('Solar Load initialized');
    }

}

module.exports = SolarLoad;
