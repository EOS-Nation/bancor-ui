import { VuexModule, mutation, action, Module } from "vuex-class-component";
import web3 from "web3";

const tx = async (data: any) =>
  new Promise((resolve, reject) => {
    // @ts-ignore
    const ethereum = window["ethereum"];
    ethereum.sendAsync(data, function(err: any, result: any) {
      resolve(result);
      reject(err);
    });
  });

@Module({ namespacedPath: "eth/" })
export class EthereumModule extends VuexModule {
  loggedInAccount: string = "";

  @mutation setLoggedInAccount(account: string) {
    this.loggedInAccount = account;
  }

  get isAuthenticated() {
    return this.loggedInAccount;
  }

  get ethereum() {
    // @ts-ignore
    return window["ethereum"];
  }

  @action async connect() {
    // @ts-ignore
    if (typeof window.ethereum !== "undefined") {
      const accounts = await this.ethereum.enable();
      this.setLoggedInAccount(accounts[0]);
    } else {
      throw new Error("Ethereum not found.");
    }
  }

  @action async tx(params: any) {
    return tx({
      method: "eth_sendTransaction",
      params,
      from: this.isAuthenticated
    });
  }

  @action async transfer({
    floatAmount,
    recipient
  }: {
    floatAmount: string;
    recipient: string;
  }) {
    if (!floatAmount) throw new Error("Float Amount required.");
    if (!web3.utils.isAddress(recipient))
      throw new Error("Recipient must be valid ETH address");
    const weiAmount = web3.utils.toWei(floatAmount);
    const value = web3.utils.toHex(weiAmount);
    const params = [
      {
        from: this.isAuthenticated,
        to: recipient,
        value
      }
    ];
    return this.tx(params);
  }


}

export const eth = EthereumModule.ExtractVuexModule(EthereumModule);
