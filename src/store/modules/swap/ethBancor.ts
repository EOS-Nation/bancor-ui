import { createModule, mutation, action } from "vuex-class-component";
import {
  ProposedFromTransaction,
  ProposedToTransaction,
  ProposedConvertTransaction,
  LiquidityParams,
  OpposingLiquidParams,
  OpposingLiquid,
  TradingModule,
  LiquidityModule,
  BaseToken,
  CreatePoolModule,
  CreatePoolParams,
  ModalChoice,
  ViewToken,
  ViewRelay,
  TokenPrice,
  Section,
  Step,
  HistoryModule,
  ViewAmount,
  ModuleParam,
  ConvertReturn,
  UserPoolBalances,
  CallReturn,
  PoolTokenPosition
} from "@/types/bancor";
import { ethBancorApi } from "@/api/bancorApiWrapper";
import {
  web3,
  Relay,
  Token,
  fetchReserveBalance,
  compareString,
  findOrThrow,
  updateArray,
  networkTokens,
  isOdd,
  multiSteps,
  EthNetworks,
  PoolType,
  Anchor,
  PoolToken,
  TraditionalRelay,
  ChainLinkRelay,
  SmartToken,
  PoolContainer,
  viewTokenToModalChoice,
  reserveIncludedInRelay,
  sortAlongSide,
  RelayWithReserveBalances,
  createIndexes,
  rebuildFromIndex,
  ConverterV2Row,
  buildTokenId,
  sortByLiqDepth
} from "@/api/helpers";
import { ContractSendMethod } from "web3-eth-contract";
import {
  ABIContractRegistry,
  ABIConverterRegistry,
  ethErc20WrapperContract,
  ethReserveAddress
} from "@/api/eth/ethAbis";
import {
  getApprovedBalanceWei,
  getReturnByPath,
  liquidationLimit,
  getConvertersByAnchors,
  getAnchors,
  getConvertibleTokenAnchors,
  conversionPath
} from "@/api/eth/contractWrappers";
import { toWei, fromWei, isAddress, toHex, asciiToHex } from "web3-utils";
import Decimal from "decimal.js";
import axios, { AxiosResponse } from "axios";
import { vxm } from "@/store";
import wait from "waait";
import {
  uniqWith,
  chunk,
  differenceWith,
  isEqual,
  zip,
  differenceBy,
  flatMap
} from "lodash";
import {
  buildNetworkContract,
  buildV2PoolsContainer,
  buildRegistryContract,
  buildV28ConverterContract,
  buildV2Converter,
  buildMultiCallContract,
  buildContainerContract,
  buildConverterContract,
  buildTokenContract
} from "@/api/eth/contractTypes";
import {
  MinimalRelay,
  expandToken,
  generateEthPath,
  shrinkToken,
  TokenSymbol
} from "@/api/eth/helpers";
import { ethBancorApiDictionary } from "@/api/bancorApiRelayDictionary";
import {
  getSmartTokenHistory,
  fetchSmartTokens,
  HistoryItem
} from "@/api/zumZoom";
import { sortByNetworkTokens } from "@/api/sortByNetworkTokens";
import { findNewPath } from "@/api/eosBancorCalc";
import { priorityEthPools } from "./staticRelays";
import BigNumber from "bignumber.js";
import { knownVersions } from "@/api/knownConverterVersions";
import { openDB, DBSchema } from "idb/with-async-ittr.js";

const calculatePoolTokenWithdrawalWei = (
  poolToken: Token,
  reserveToken: Token,
  reserveDecAmount: string
): string => {
  if (poolToken.decimals == reserveToken.decimals) {
    return expandToken(reserveDecAmount, poolToken.decimals);
  }
  const precisionDifference = poolToken.decimals - reserveToken.decimals;
  const expansion = poolToken.decimals - precisionDifference;
  return expandToken(reserveDecAmount, expansion);
};

const getAnchorTokenAddresses = (relay: Relay): string[] => {
  if (relay.converterType == PoolType.ChainLink) {
    const actualRelay = relay as ChainLinkRelay;
    return actualRelay.anchor.poolTokens.map(x => x.poolToken.contract);
  } else if (relay.converterType == PoolType.Traditional) {
    const actualRelay = relay as TraditionalRelay;
    return [actualRelay.anchor.contract];
  } else {
    throw new Error("Failed to identify type of relay passed");
  }
};

interface MyDB extends DBSchema {
  anchorPair: {
    key: string;
    value: ConverterAndAnchor;
  };
}

type MultiCallReturn = [string, { success: boolean; data: string }];

interface RefinedAbiRelay {
  anchorAddress: string;
  reserves: [string, string];
  version: number;
  converterType: PoolType;
  converterAddress: string;
  connectorToken1: string;
  connectorToken2: string;
  connectorTokenCount: string;
  conversionFee: string;
  owner: string;
}

const determineConverterType = (
  converterType: string | undefined
): PoolType => {
  if (typeof converterType == "undefined") {
    return PoolType.Traditional;
  } else if (Number(converterType) == 32) {
    return PoolType.Traditional;
  } else if (Number(converterType) == 1) {
    return PoolType.Traditional;
  } else if (Number(converterType) == 2) {
    return PoolType.ChainLink;
  } else if (Number(converterType) == 0) {
    return PoolType.Liquid;
  }
  throw new Error("Failed to determine the converter type");
};

const expensiveConvertersAndAnchors: ConverterAndAnchor[] = [
  {
    anchorAddress: "0xd16a3A892695ec9a47EFFdD5247980a8d2be3fF2",
    converterAddress: "0x55baD7CDDe403872E1A4EAB787F67177A41aA716"
  },
  {
    anchorAddress: "0xa7e21e7584fc6fDf6Fa978a5d4981352B0260954",
    converterAddress: "0xcFd79b484f33c8098E2fd279729BEcC1c53a362f"
  },
  {
    anchorAddress: "0x6f8BeaDF9eCd851be239b616149aF3E69D49ce11",
    converterAddress: "0xd79Bd02053287a2a635B09b63136806D174d51a5"
  },
  {
    anchorAddress: "0x1344381f0e93a2A1Ab0BFd2fE209a9BD01343933",
    converterAddress: "0x62aeE73B82Cc64dd3c65ac220838210556C5c897"
  },
  {
    anchorAddress: "0x04A3030c94Fb2dBE2b898d8cBf6Fd1c656FA69dd",
    converterAddress: "0xe8b06d938a863bb2c82644125d7714844b8A98a4"
  },
  {
    anchorAddress: "0x1F5350558F1E3e8Bf370d4d552F3ebC785bf2979",
    converterAddress: "0xEF8c6c64926A9548210adDC22e8ed6034E39b0Da"
  },
  {
    anchorAddress: "0x0F92330EAaBa84CB54b068F4331Cc40Dd2A98236",
    converterAddress: "0x66437A8E8D98ee27B5F5B99aB7835b6A887d191b"
  },
  {
    anchorAddress: "0xE355dcF475ff7569B8b74d5165a532ABa87c25bf",
    converterAddress: "0x8e11504d39dfc576a78cAC7FF835Bf9dcBb2453F"
  },
  {
    anchorAddress: "0x534DF0Ec6D65cD6fE1b05D3b8c935c97Eb844190",
    converterAddress: "0x850e6fDc53816Fb32d6A1B45aFD95e9e6420F9d7"
  },
  {
    anchorAddress: "0x0aacA86e54Fe70eDd7c86cBF3cFb470caA49FAeF",
    converterAddress: "0x6cba561bB35919597531d9cF6720A48867fdA8c9"
  },
  {
    anchorAddress: "0x44AA95Fa2e84d3acdACDeFfe16d9b5eD0498cC8b",
    converterAddress: "0xD9532211E102874E46E26f116877DA086CB20a51"
  },
  {
    anchorAddress: "0xFA3Bba432c0499c091F821aEB22FC36c4F8c78e3",
    converterAddress: "0x7D86d4d01DD72Db066655D38C1de0006c5B2224f"
  },
  {
    anchorAddress: "0x09C5188d9fE33d218Cc186baE8F985907b25eBEe",
    converterAddress: "0x99e8e0e3D4cd50f856f675567FeC8eb732CfE2d7"
  },
  {
    anchorAddress: "0x4EB61146e9Ad2a9D395956eF410EBaF7459f4622",
    converterAddress: "0x4b536A64f25f2070B5ACe6d79f6CeFf0D9Be4DC1"
  },
  {
    anchorAddress: "0x368B3D50E51e8bf62E6C73fc389e4102B9aEB8e2",
    converterAddress: "0xa4FfBDc5B0F5e61537c0F43FAD28Cf45E94BdE43"
  },
  {
    anchorAddress: "0x91AFdd8EF36DEf4fa2B9d7A05420f9D0E4F775d1",
    converterAddress: "0xC9A722be71Ac8B1Faa00c995e6d47835C933DAd6"
  },
  {
    anchorAddress: "0xf001bC665ffac52c6a969305c3BDaaf88DE4bBC8",
    converterAddress: "0x6DAE0133395AeC73B122fF010Ce85b78209310C2"
  },
  {
    anchorAddress: "0xEE4dC4C5Ca843B83035d8E5159AC1bd1b4EbdfF5",
    converterAddress: "0x7754717cDA23EfF9E0962a10E9Bb5B95aD2f4cdB"
  },
  {
    anchorAddress: "0x038869E70E0f927EaA42F75d1E3bF83008e4c88E",
    converterAddress: "0x1adD247e9a3E63490e1935AF8ef361505A285F77"
  },
  {
    anchorAddress: "0xFD556AB5010A4076fee1A232117E4ef549A84032",
    converterAddress: "0x971E89e5202e2E4d4cB16Bc89F742D151931559d"
  }
];

const smartTokenAnchor = (smartToken: Token) => {
  return { anchor: smartToken, converterType: PoolType.Traditional };
};

const calculateSlippage = (
  slippageLessRate: BigNumber,
  slippagedRate: BigNumber
): BigNumber => {
  if (slippagedRate.gt(slippageLessRate)) throw new Error("Rates are bad");
  const result = slippageLessRate.minus(slippagedRate).abs();
  return result.div(slippageLessRate);
};

const buildRate = (amountEntered: BigNumber, returnAmount: BigNumber) =>
  returnAmount.div(amountEntered);

const buildRelayFeedChainkLink = ({
  relays,
  usdPriceOfBnt
}: {
  relays: RawV2Pool[];
  usdPriceOfBnt: number;
}): ReserveFeed[] => {
  return relays.flatMap(relay => {
    const reserveBalances = relay.reserves;
    const reserveWeights = relay.reserves.map(balance => balance.reserveWeight);

    const [secondaryReserveToken, primaryReserveToken] = sortByNetworkTokens(
      reserveBalances,
      reserve => reserve.token.symbol
    ).map(token => ({
      ...token,
      decAmount: Number(shrinkToken(token.stakedBalance, token.token.decimals))
    }));

    const [
      primaryReserveDecWeight,
      secondaryReserveDecWeight
    ] = reserveWeights.map(weightPpm =>
      new BigNumber(weightPpm).div(oneMillion)
    );

    const secondarysPrice =
      secondaryReserveToken.token.symbol == "USDB" ? 1 : usdPriceOfBnt;
    const secondarysLiqDepth =
      secondaryReserveToken.decAmount * secondarysPrice;

    const wholeLiquidityDepth = new BigNumber(secondarysLiqDepth).div(
      secondaryReserveDecWeight
    );
    const primaryLiquidityDepth = wholeLiquidityDepth.minus(secondarysLiqDepth);

    return [
      {
        tokenId: primaryReserveToken.token.contract,
        poolId: relay.anchorAddress,
        liqDepth: primaryLiquidityDepth.toNumber(),
        costByNetworkUsd: primaryLiquidityDepth
          .div(secondaryReserveToken.decAmount)
          .toNumber()
      },
      {
        tokenId: secondaryReserveToken.token.contract,
        poolId: relay.anchorAddress,
        liqDepth: secondarysLiqDepth,
        costByNetworkUsd: secondarysPrice
      }
    ];
  });
};

const decodeHex = (hex: string, type: string | any[]) => {
  const typeIsArray = Array.isArray(type);
  try {
    if (typeIsArray) {
      return web3.eth.abi.decodeParameters(type as any[], hex);
    } else {
      return web3.eth.abi.decodeParameter(type as string, hex);
    }
  } catch (e) {
    console.warn(
      `Failed to decode hex ${hex} treating it as type ${type}. ${e.message}`
    );
    return undefined;
  }
};

const relayTemplate = (): AbiTemplate => {
  const contract = buildV28ConverterContract();
  return {
    owner: contract.methods.owner(),
    converterType: contract.methods.converterType(),
    version: contract.methods.version(),
    connectorTokenCount: contract.methods.connectorTokenCount(),
    conversionFee: contract.methods.conversionFee(),
    connectorToken1: contract.methods.connectorTokens(0),
    connectorToken2: contract.methods.connectorTokens(1)
  };
};

const v2PoolBalanceTemplate = (reserves: string[]): AbiTemplate => {
  const contract = buildV2Converter();
  const [reserveOne, reserveTwo] = reserves;
  return {
    primaryReserveToken: contract.methods.primaryReserveToken(),
    secondaryReserveToken: contract.methods.secondaryReserveToken(),
    poolTokenOne: contract.methods.poolToken(reserveOne),
    poolTokenTwo: contract.methods.poolToken(reserveTwo),
    reserveOneStakedBalance: contract.methods.reserveStakedBalance(reserveOne),
    reserveTwoStakedBalance: contract.methods.reserveStakedBalance(reserveTwo),
    effectiveReserveWeights: contract.methods.effectiveReserveWeights()
  };
};

const miniPoolTokenTemplate = (): AbiTemplate => {
  const contract = buildContainerContract();
  return {
    symbol: contract.methods.symbol(),
    decimals: contract.methods.decimals(),
    poolTokens: contract.methods.poolTokens()
  };
};

interface AbiTemplate {
  [key: string]: CallReturn<any>;
}

interface AbiEncodedTemplate {
  [key: string]: string;
}

interface DecodedResult<T> {
  originAddress: string;
  data: T;
}

interface TokenWei {
  tokenContract: string;
  weiAmount: string;
}

const decodeCallGroup = <T>(
  template: AbiTemplate,
  calls: MultiCallReturn[]
): DecodedResult<T> => {
  const originAddress = calls[0][0];
  const allSame = calls.every(([address]) => address == originAddress);
  if (!allSame)
    throw new Error("Was expecting all origin addresses to be the same");

  const props = Object.keys(template);
  if (props.length !== calls.length)
    throw new Error("Was expecting as many calls as props");

  const methods: { name: string; type: string | string[] }[] = props.map(
    prop => ({
      name: prop,
      type:
        template[prop]._method.outputs.length == 1
          ? template[prop]._method.outputs[0].type
          : template[prop]._method.outputs.map(x => x.type)
    })
  );

  const obj = methods.reduce(
    (acc, item, index) => {
      const [originAddress, res] = calls[index];
      return {
        ...acc,
        [item.name]: res.success ? decodeHex(res.data, item.type) : undefined
      };
    },
    {} as T
  );

  return {
    originAddress,
    data: obj
  };
};

const createCallGroup = (
  template: AbiEncodedTemplate,
  originAddress: string
): MultiCall[] =>
  Object.keys(template).map(key => [originAddress, template[key]]);

interface RawV2Pool {
  reserves: {
    token: Token;
    reserveAddress: string;
    stakedBalance: string;
    reserveWeight: string;
    poolTokenAddress: string;
  }[];
  converterAddress: string;
  anchorAddress: string;
}

interface V2Response {
  reserveFeeds: (
    | {
        tokenId: string;
        poolId: string;
        costByNetworkUsd: number;
        liqDepth: number;
      }
    | ReserveFeed)[];
  pools: (RelayWithReserveBalances | ChainLinkRelay)[];
}

const sortFeedByExtraProps = (a: ReserveFeed, b: ReserveFeed) => {
  if (a.change24H || a.volume24H) return -1;
  if (b.change24H || a.volume24H) return 1;
  return 0;
};

const compareAnchorAndConverter = (
  a: ConverterAndAnchor,
  b: ConverterAndAnchor
) =>
  compareString(a.anchorAddress, b.anchorAddress) &&
  compareString(a.converterAddress, b.converterAddress);
interface RawAbiRelay {
  connectorToken1: string;
  connectorToken2: string;
  connectorTokenCount: string;
  conversionFee: string;
  owner: string;
  version: string;
  converterType?: string;
}

const zipAnchorAndConverters = (
  anchorAddresses: string[],
  converterAddresses: string[]
): ConverterAndAnchor[] => {
  if (anchorAddresses.length !== converterAddresses.length)
    throw new Error(
      "was expecting as many anchor addresses as converter addresses"
    );
  const zipped = zip(anchorAddresses, converterAddresses) as [string, string][];
  return zipped.map(([anchorAddress, converterAddress]) => ({
    anchorAddress: anchorAddress!,
    converterAddress: converterAddress!
  }));
};

const pickEthToken = (obj: any): Token => ({
  contract: obj.contract,
  decimals: obj.decimals,
  network: "ETH",
  symbol: obj.symbol
});

interface AbiRelay extends RawAbiRelay {
  converterAddress: string;
}

interface RawAbiToken {
  symbol: string;
  decimals: string;
}

interface RawAbiCentralPoolToken extends RawAbiToken {
  poolTokens?: string[];
}

interface AbiCentralPoolToken extends RawAbiCentralPoolToken {
  contract: string;
}

interface ConverterAndAnchor {
  converterAddress: string;
  anchorAddress: string;
}
interface Method {
  type?: string | string[];
  name: string;
  method: string;
  methodName: string;
}

type MultiCall = [string, string];

const networkTokenAddresses = [
  "0x309627af60F0926daa6041B8279484312f2bf060",
  "0x1F573D6Fb3F13d689FF844B4cE37794d79a7FF1C"
];

const metaToModalChoice = (meta: TokenMeta): ModalChoice => ({
  id: meta.contract,
  contract: meta.contract,
  symbol: meta.symbol,
  img: meta.image
});

const isTraditional = (relay: Relay): boolean =>
  typeof relay.anchor == "object" &&
  relay.converterType == PoolType.Traditional;

const isChainLink = (relay: Relay): boolean =>
  Array.isArray((relay.anchor as PoolContainer).poolTokens) &&
  relay.converterType == PoolType.ChainLink;

const assertTraditional = (relay: Relay): TraditionalRelay => {
  if (isTraditional(relay)) {
    return relay as TraditionalRelay;
  }
  throw new Error("Not a traditional relay");
};

const assertChainlink = (relay: Relay): ChainLinkRelay => {
  if (isChainLink(relay)) {
    return relay as ChainLinkRelay;
  }
  throw new Error("Not a chainlink relay");
};

interface AnchorProps {
  anchor: Anchor;
  converterType: PoolType;
}

const iouTokensInRelay = (relay: Relay): Token[] => {
  if (relay.converterType == PoolType.ChainLink) {
    const poolContainer = relay.anchor as PoolContainer;
    const poolTokens = poolContainer.poolTokens;
    const tokens = poolTokens.map(token => token.poolToken);
    return tokens;
  } else if (relay.converterType == PoolType.Traditional) {
    const smartToken = relay.anchor as SmartToken;
    return [smartToken];
  } else throw new Error("Failed to identify pool");
};

const reserveTokensInRelay = (relay: Relay): Token[] => relay.reserves;

const tokensInRelay = (relay: Relay): Token[] => [
  ...reserveTokensInRelay(relay),
  ...iouTokensInRelay(relay)
];

interface EthNetworkVariables {
  contractRegistry: string;
  bntToken: string;
  ethToken: string;
  multiCall: string;
}

const getNetworkVariables = (ethNetwork: EthNetworks): EthNetworkVariables => {
  switch (ethNetwork) {
    case EthNetworks.Mainnet:
      return {
        contractRegistry: "0x52Ae12ABe5D8BD778BD5397F99cA900624CfADD4",
        bntToken: "0x1F573D6Fb3F13d689FF844B4cE37794d79a7FF1C",
        ethToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        multiCall: "0x5Eb3fa2DFECdDe21C950813C665E9364fa609bD2"
      };
    case EthNetworks.Ropsten:
      return {
        contractRegistry: "0xA6DB4B0963C37Bc959CbC0a874B5bDDf2250f26F",
        bntToken: "0x98474564A00d15989F16BFB7c162c782b0e2b336",
        ethToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        multiCall: "0xf3ad7e31b052ff96566eedd218a823430e74b406"
      };
    default:
      throw new Error("Information not stored");
  }
};

interface WeiExtendedAsset {
  weiAmount: string;
  contract: string;
}

const relayToMinimal = (relay: Relay): MinimalRelay => ({
  contract: relay.contract,
  reserves: relay.reserves.map(
    (reserve): TokenSymbol => ({
      contract: reserve.contract,
      symbol: reserve.symbol
    })
  ),
  anchorAddress: isTraditional(relay)
    ? (relay.anchor as SmartToken).contract
    : (relay.anchor as PoolContainer).poolContainerAddress
});

const sortSmartTokenAddressesByHighestLiquidity = (
  tokens: TokenPrice[],
  smartTokenAddresses: string[]
): string[] => {
  const sortedTokens = tokens
    .slice()
    .sort((a, b) => b.liquidityDepth - a.liquidityDepth);

  const sortedDictionary = sortedTokens
    .map(
      token =>
        ethBancorApiDictionary.find(dic =>
          compareString(token.id, dic.tokenId)
        )!
    )
    .filter(Boolean);

  const res = sortAlongSide(
    smartTokenAddresses,
    pool => pool,
    sortedDictionary.map(x => x.smartTokenAddress)
  );

  const isSame = res.every((item, index) => smartTokenAddresses[index] == item);
  if (isSame)
    console.warn(
      "Sorted by Highest liquidity sorter is returning the same array passed"
    );
  return res;
};

interface EthOpposingLiquid {
  smartTokenAmount: ViewAmount;
  opposingAmount: string;
  shareOfPool: number;
  singleUnitCosts: ViewAmount[];
}

interface Handler {
  finisher: (multiCalls: MultiCallReturn[]) => unknown;
  callGroups: MultiCall[][];
}

interface RawAbiV2PoolBalances {
  poolTokenOne: string;
  poolTokenTwo: string;
  primaryReserveToken: string;
  secondaryReserveToken: string;
  reserveOneStakedBalance: string;
  reserveTwoStakedBalance: string;
  effectiveReserveWeights: { 0: string; 1: string };
}

type OriginAndTemplate = [string, AbiTemplate];

const arrToObject = (arr: { encoded: string; key: string }[]) =>
  arr.reduce((acc, item) => {
    return {
      ...acc,
      [item.key]: item.encoded
    };
  }, {});

const matchKeyOrdering = (sortedOrder: string[], obj: any) => {
  const newObj = sortedOrder.reduce(
    (acc, item) => ({
      ...acc,
      [item]: obj[item]
    }),
    {}
  );

  const testKeys = Object.keys(newObj);
  const correct = isEqual(sortedOrder, testKeys);
  if (!correct) {
    throw new Error("does not match key ordering");
  }
  return newObj;
};

const createCallGroups = (
  originAndTemplates: OriginAndTemplate[]
): MultiCall[][] => {
  if (originAndTemplates.length == 0) return [];
  const [firstOrigin, firstTemplate] = originAndTemplates[0];
  const templateOrder = Object.keys(firstTemplate);
  const methodsArr = Object.keys(firstTemplate).map(key => ({
    method: firstTemplate[key],
    key
  }));
  const noArgMethods = methodsArr.filter(
    template => template.method.arguments.length == 0
  );
  const argMethods = methodsArr.filter(
    template => template.method.arguments.length > 0
  );
  const sameArgMethods = argMethods.filter(method => {
    const allMethods = originAndTemplates.map(
      ([_, methods]) => methods[method.key]
    );
    const firstArgs = allMethods[0].arguments;
    return allMethods.every(method => isEqual(method.arguments, firstArgs));
  });

  const staticMethods = [...noArgMethods, ...sameArgMethods];
  const dynamicMethods = differenceBy(methodsArr, staticMethods, "key");
  if (staticMethods.length + dynamicMethods.length !== methodsArr.length)
    throw new Error("Failed filtering methods");

  const staticEncoded = staticMethods.map(method => ({
    key: method.key,
    encoded: method.method.encodeABI()
  }));

  const dynamic = originAndTemplates.map(([originAddress, abiTemplate]) => {
    const dynamicEncoded = dynamicMethods.map(dynamicMethod => ({
      encoded: abiTemplate[dynamicMethod.key].encodeABI(),
      key: dynamicMethod.key
    }));
    return {
      templatesArray: [...dynamicEncoded, ...staticEncoded],
      originAddress
    };
  });

  const objectBase = dynamic.map(d => ({
    originAddress: d.originAddress,
    data: arrToObject(d.templatesArray)
  }));

  const multiCalls = objectBase.map(obj =>
    createCallGroup(
      matchKeyOrdering(templateOrder, obj.data),
      obj.originAddress
    )
  );
  return multiCalls;
};

const relayHandler = (converterAddresses: string[]): Handler => {
  const template = relayTemplate();

  const originAndTemplates: OriginAndTemplate[] = converterAddresses.map(
    address => [address, template]
  );
  const callGroups = createCallGroups(originAndTemplates);

  const finisher = (callGroupRes: MultiCallReturn[]): unknown => {
    const decoded = decodeCallGroup<RawAbiRelay>(template, callGroupRes);
    return {
      ...decoded.data,
      converterAddress: decoded.originAddress
    };
  };

  return {
    finisher,
    callGroups
  };
};

interface RawAbiReserveBalance {
  reserveOne: string;
  reserveTwo: string;
}

const reserveBalanceHandler = (
  relays: {
    converterAddress: string;
    reserves: [string, string];
    version: number;
  }[]
): Handler => {
  const template = reserveBalanceTemplate([
    ethReserveAddress,
    ethReserveAddress
  ]);

  const originAndTemplates: OriginAndTemplate[] = relays.map(relay => [
    relay.converterAddress,
    reserveBalanceTemplate(relay.reserves)
  ]);
  const callGroups = createCallGroups(originAndTemplates);

  const finisher = (callGroupsRes: MultiCallReturn[]) => {
    const decoded = decodeCallGroup<RawAbiReserveBalance>(
      template,
      callGroupsRes
    );
    return decoded;
  };

  return {
    callGroups,
    finisher
  };
};

const hasTwoConnectors = (relay: RefinedAbiRelay) => {
  const test = relay.connectorTokenCount == "2";
  if (!test)
    console.warn(
      "Dropping relay",
      relay.anchorAddress,
      "because it does not have a connector count of two"
    );
  return test;
};

const reservesInTokenMeta = (meta: TokenMeta[]) => (relay: RefinedAbiRelay) => {
  const test = relay.reserves.filter(reserveAddress =>
    meta.some(meta => compareString(meta.contract, reserveAddress))
  );
  if (test.length == relay.reserves.length) return true;
  const difference = differenceWith(relay.reserves, test, compareString);
  console.warn(
    "Dropping",
    relay.anchorAddress,
    `because ${
      difference.length == 1 ? "one" : "all"
    } of it's reserves are not included in token meta - ${difference.join(" ")}`
  );
  return false;
};

const networkTokenIncludedInReserves = (networkTokenAddresses: string[]) => (
  relay: RefinedAbiRelay
) => {
  const test = relay.reserves.some(reserve =>
    networkTokenAddresses.some(networkAddress =>
      compareString(networkAddress, reserve)
    )
  );
  if (!test)
    console.warn(
      "Dropping",
      relay,
      "because it does not feature a network token"
    );
  return test;
};

interface StakedAndReserve {
  converterAddress: string;
  reserves: {
    reserveAddress: string;
    stakedBalance: string;
    reserveWeight: string;
    poolTokenAddress: string;
  }[];
}

const stakedAndReserveHandler = (
  relays: {
    converterAdress: string;
    reserveOne: string;
    reserveTwo: string;
  }[]
): Handler => {
  const template = v2PoolBalanceTemplate([
    ethReserveAddress,
    ethReserveAddress
  ]);

  const originAndTemplates: OriginAndTemplate[] = relays.map(relay => [
    relay.converterAdress,
    v2PoolBalanceTemplate([relay.reserveOne, relay.reserveTwo])
  ]);
  const callGroups = createCallGroups(originAndTemplates);

  const finisher = (callGroupsRes: MultiCallReturn[]) => {
    const decoded = decodeCallGroup<RawAbiV2PoolBalances>(
      template,
      callGroupsRes
    );

    const data = decoded.data;
    console.log(data, "is data");
    return {
      converterAddress: decoded.originAddress,
      reserves: [
        {
          reserveAddress: data.primaryReserveToken,
          stakedBalance: data.reserveOneStakedBalance,
          reserveWeight: data.effectiveReserveWeights[0],
          poolTokenAddress: data.poolTokenOne
        },
        {
          reserveAddress: data.secondaryReserveToken,
          stakedBalance: data.reserveTwoStakedBalance,
          reserveWeight: data.effectiveReserveWeights[1],
          poolTokenAddress: data.poolTokenTwo
        }
      ]
    };
  };
  return {
    callGroups,
    finisher
  };
};

const polishTokens = (tokenMeta: TokenMeta[], tokens: Token[]) => {
  const ethReserveToken: Token = {
    contract: ethReserveAddress,
    decimals: 18,
    network: "ETH",
    symbol: "ETH"
  };

  const ethHardCode = updateArray(
    tokens,
    token => compareString(token.contract, ethReserveAddress),
    _ => ethReserveToken
  );

  const symbolOveride = updateArray(
    ethHardCode,
    token => typeof token.symbol == "undefined" || token.symbol == "",
    token => ({
      ...token,
      symbol: tokenMeta.find(meta =>
        compareString(token.contract, meta.contract)
      )!.symbol
    })
  );

  const decimalIsWrong = (decimals: number | undefined) =>
    typeof decimals == "undefined" || Number.isNaN(decimals);

  const missingDecimals = updateArray(
    symbolOveride,
    token => decimalIsWrong(token.decimals),
    missingDecimal => {
      const meta = tokenMeta.find(x =>
        compareString(x.contract, missingDecimal.contract)
      )!;
      if (Object.keys(meta).includes("precision")) {
        return {
          ...missingDecimal,
          decimals: meta.precision!
        };
      }
      console.warn(
        "Token Meta couldnt help determine decimals of token address",
        missingDecimal.contract
      );
      return {
        ...missingDecimal
      };
    }
  ).filter(token => !decimalIsWrong(token.decimals));

  const addedEth = [...missingDecimals, ethReserveToken];
  const uniqueTokens = uniqWith(addedEth, (a, b) =>
    compareString(a.contract, b.contract)
  );

  const difference = differenceWith(tokens, uniqueTokens, (a, b) =>
    compareString(a.contract, b.contract)
  );
  if (difference.length > 0) {
    console.warn("Polish tokens is dropping", difference, "tokens");
  }
  return uniqueTokens;
};

const seperateMiniTokens = (tokens: AbiCentralPoolToken[]) => {
  const smartTokens = tokens
    .filter(token => !token.poolTokens)
    .map(pickEthToken);

  const poolTokenAddresses = tokens
    .filter(token => Array.isArray(token.poolTokens))
    .map(token => ({
      anchorAddress: token.contract,
      poolTokenAddresses: token.poolTokens as string[]
    }));

  const rebuiltLength = poolTokenAddresses.length + smartTokens.length;
  if (rebuiltLength !== tokens.length) {
    console.error("failed to rebuild properly");
  }
  return { smartTokens, poolTokenAddresses };
};

const nameOriginAs = <T>(propertyName: string, obj: DecodedResult<T>) => ({
  ...obj.data,
  [propertyName]: obj.originAddress
});

const miniPoolHandler = (anchorAddresses: string[]): Handler => {
  const template = miniPoolTokenTemplate();

  const originAndTemplates: OriginAndTemplate[] = anchorAddresses.map(
    address => [address, template]
  );
  const callGroups = createCallGroups(originAndTemplates);

  const finisher = (callGroupsRes: MultiCallReturn[]): unknown => {
    const decoded = decodeCallGroup<RawAbiCentralPoolToken>(
      template,
      callGroupsRes
    );

    return nameOriginAs("contract", decoded);
  };

  return { finisher, callGroups };
};

const tokenHandler = (tokenAddresses: string[]): Handler => {
  const contract = buildTokenContract();
  const template: AbiTemplate = {
    symbol: contract.methods.symbol(),
    decimals: contract.methods.decimals()
  };

  const originAndTemplates: OriginAndTemplate[] = tokenAddresses.map(
    address => [address, template]
  );
  const callGroups = createCallGroups(originAndTemplates);

  const finisher = (callGroupsRes: MultiCallReturn[]): Token => {
    const decoded = decodeCallGroup<RawAbiToken>(template, callGroupsRes);

    return {
      contract: decoded.originAddress,
      symbol: decoded.data.symbol,
      decimals: Number(decoded.data.decimals),
      network: "ETH"
    };
  };

  return {
    finisher,
    callGroups
  };
};

const reserveBalanceTemplate = (reserves: string[]) => {
  const contract = buildConverterContract();
  const [reserveOne, reserveTwo] = reserves;
  return {
    reserveOne: contract.methods.getConnectorBalance(reserveOne),
    reserveTwo: contract.methods.getConnectorBalance(reserveTwo)
  };
};

const relayIncludesAtLeastOneNetworkToken = (relay: Relay) =>
  relay.reserves.some(reserve => networkTokens.includes(reserve.symbol));

const compareRelayFeed = (a: ReserveFeed, b: ReserveFeed) =>
  compareString(a.poolId, b.poolId) && compareString(a.tokenId, b.tokenId);

const tokenPriceToFeed = (
  tokenAddress: string,
  smartTokenAddress: string,
  usdPriceOfEth: number,
  tokenPrice: TokenPrice
): ReserveFeed => ({
  tokenId: tokenAddress,
  poolId: smartTokenAddress,
  costByNetworkUsd: tokenPrice.price,
  liqDepth: tokenPrice.liquidityDepth * usdPriceOfEth * 2,
  change24H: tokenPrice.change24h,
  volume24H: tokenPrice.volume24h.USD
});

interface RegisteredContracts {
  BancorNetwork: string;
  BancorConverterRegistry: string;
}

const removeLeadingZeros = (hexString: string) => {
  console.log(hexString, "was received on remove leading zeros");
  const withoutOx = hexString.startsWith("0x") ? hexString.slice(2) : hexString;
  const initialAttempt =
    "0x" + withoutOx.slice(withoutOx.split("").findIndex(x => x !== "0"));
  if (isAddress(initialAttempt)) return initialAttempt;
  const secondAttempt = [
    "0",
    "x",
    "0",
    ...initialAttempt.split("").slice(2)
  ].join("");
  if (isAddress(secondAttempt)) return secondAttempt;
  else throw new Error(`Failed parsing hex ${hexString}`);
};

const zeroAddress: string = "0x0000000000000000000000000000000000000000";

const relayReservesIncludedInTokenMeta = (tokenMeta: TokenMeta[]) => (
  relay: Relay
) =>
  relay.reserves.every(reserve =>
    tokenMeta.some(meta => compareString(reserve.contract, meta.contract))
  );

const percentageOfReserve = (percent: number, existingSupply: string): string =>
  new Decimal(percent).times(existingSupply).toFixed(0);

const percentageIncrease = (deposit: string, existingSupply: string): number =>
  new Decimal(deposit).div(existingSupply).toNumber();

const calculateOppositeFundRequirement = (
  deposit: string,
  depositsSupply: string,
  oppositesSupply: string
): string => {
  const increase = percentageIncrease(deposit, depositsSupply);
  return percentageOfReserve(increase, oppositesSupply);
};

const calculateOppositeLiquidateRequirement = (
  reserveAmount: string,
  reserveBalance: string,
  oppositeReserveBalance: string
) => {
  const increase = percentageIncrease(reserveAmount, reserveBalance);
  return percentageOfReserve(increase, oppositeReserveBalance);
};

const oneMillion = new BigNumber(1000000);

const calculateFundReward = (
  reserveAmount: string,
  reserveSupply: string,
  smartSupply: string
) => {
  Decimal.set({ rounding: 0 });
  return new Decimal(reserveAmount)
    .div(reserveSupply)
    .times(smartSupply)
    .times(0.99)
    .toFixed(0);
};

const calculateLiquidateCost = (
  reserveAmount: string,
  reserveBalance: string,
  smartSupply: string
) => {
  const percent = percentageIncrease(reserveAmount, reserveBalance);
  return percentageOfReserve(percent, smartSupply);
};

const percentDifference = (smallAmount: string, bigAmount: string) =>
  new Decimal(smallAmount).div(bigAmount).toNumber();

const tokenMetaDataEndpoint =
  "https://raw.githubusercontent.com/Velua/eth-tokens-registry/master/tokens.json";

interface TokenMeta {
  id: string;
  image: string;
  contract: string;
  symbol: string;
  name: string;
  precision?: number;
}

const metaToTokenAssumedPrecision = (token: TokenMeta): Token => ({
  contract: token.contract,
  decimals: token.precision!,
  network: "ETH",
  symbol: token.symbol
});

const getTokenMeta = async (currentNetwork: EthNetworks) => {
  const networkVars = getNetworkVariables(currentNetwork);
  if (currentNetwork == EthNetworks.Ropsten) {
    return [
      {
        symbol: "DAI",
        contract: "0xc2118d4d90b274016cb7a54c03ef52e6c537d957",
        decimals: 18
      },
      {
        symbol: "WBTC",
        contract: "0xbde8bb00a7ef67007a96945b3a3621177b615c44",
        decimals: 8
      },
      {
        symbol: "BAT",
        contract: "0x443fd8d5766169416ae42b8e050fe9422f628419",
        decimals: 18
      },
      {
        symbol: "LINK",
        contract: "0x20fe562d797a42dcb3399062ae9546cd06f63280",
        decimals: 18
      },
      {
        contract: "0x4F5e60A76530ac44e0A318cbc9760A2587c34Da6",
        symbol: "YYYY"
      },
      {
        contract: "0x63B75DfA4E87d3B949e876dF2Cd2e656Ec963466",
        symbol: "YYY"
      },
      {
        contract: "0xAa2A908Ca3E38ECEfdbf8a14A3bbE7F2cA2a1BE4",
        symbol: "XXX"
      },
      {
        contract: networkVars.bntToken,
        symbol: "BNT"
      },
      {
        contract: networkVars.ethToken,
        symbol: "ETH"
      },
      {
        contract: "0xe4158797A5D87FB3080846e019b9Efc4353F58cC",
        symbol: "XXX"
      }
    ].map(
      (x): TokenMeta => ({
        ...x,
        id: x.contract,
        image: "https://ropsten.etherscan.io/images/main/empty-token.png",
        name: x.symbol
      })
    );
  }
  if (currentNetwork !== EthNetworks.Mainnet)
    throw new Error("Ropsten and Mainnet supported only.");

  const res: AxiosResponse<TokenMeta[]> = await axios.get(
    tokenMetaDataEndpoint
  );

  const drafted = res.data
    .filter(({ symbol, contract, image }) =>
      [symbol, contract, image].every(Boolean)
    )
    .map(x => ({ ...x, id: x.contract }));

  const existingEth = drafted.find(x => compareString(x.symbol, "eth"))!;

  const withoutEth = drafted.filter(meta => !compareString(meta.symbol, "eth"));
  const addedEth = {
    ...existingEth,
    id: ethReserveAddress,
    contract: ethReserveAddress
  };
  const final = [addedEth, existingEth, ...withoutEth];
  return uniqWith(final, (a, b) => compareString(a.id, b.id));
};

const compareRelayById = (a: Relay, b: Relay) => compareString(a.id, b.id);

interface ReserveFeed {
  poolId: string;
  tokenId: string;
  liqDepth: number;
  costByNetworkUsd?: number;
  change24H?: number;
  volume24H?: number;
}

const VuexModule = createModule({
  strict: false
});

export class EthBancorModule
  extends VuexModule.With({ namespaced: "ethBancor/" })
  implements TradingModule, LiquidityModule, CreatePoolModule, HistoryModule {
  registeredAnchorAddresses: string[] = [];
  convertibleTokenAddresses: string[] = [];
  loadingPools: boolean = true;

  bancorApiTokens: TokenPrice[] = [];
  relayFeed: readonly ReserveFeed[] = [];
  relaysList: readonly Relay[] = [];
  tokenBalances: { id: string; balance: number }[] = [];
  bntUsdPrice: number = 0;
  tokenMeta: TokenMeta[] = [];
  availableHistories: string[] = [];
  contracts: RegisteredContracts = {
    BancorNetwork: "",
    BancorConverterRegistry: ""
  };
  initiated: boolean = false;
  failedPools: string[] = [];
  currentNetwork: EthNetworks = EthNetworks.Mainnet;
  slippageTolerance = 0;

  get stats() {
    return {
      totalLiquidityDepth: this.tokens.reduce(
        (acc, item) => acc + (item.liqDepth || 0),
        0
      )
    };
  }

  @mutation setTolerance(tolerance: number) {
    this.slippageTolerance = tolerance;
  }

  @action async setSlippageTolerance(tolerance: number) {
    this.setTolerance(tolerance);
  }

  @mutation setNetwork(network: EthNetworks) {
    this.currentNetwork = network;
  }

  @mutation setBancorApiTokens(tokens: TokenPrice[]) {
    this.bancorApiTokens = tokens;
  }

  get poolTokenPositions(): PoolTokenPosition[] {
    const allIouTokens = this.relaysList.flatMap(iouTokensInRelay);
    const existingBalances = this.tokenBalances.filter(
      balance =>
        balance.balance > 0 &&
        allIouTokens.some(iouToken =>
          compareString(balance.id, iouToken.contract)
        )
    );

    const relevantRelays = this.relaysList.filter(relay =>
      iouTokensInRelay(relay).some(token =>
        existingBalances.some(balance =>
          compareString(balance.id, token.contract)
        )
      )
    );

    return relevantRelays.map(relay => {
      const anchorTokens = iouTokensInRelay(relay);
      const iouTokens = existingBalances.filter(existingBalance =>
        anchorTokens.some(anchor =>
          compareString(existingBalance.id, anchor.contract)
        )
      );

      const viewRelay = this.relay(relay.id);
      const isV1 = relay.converterType == PoolType.Traditional;
      if (isV1) {
        return {
          relay: viewRelay,
          smartTokenAmount: iouTokens[0].balance
        };
      } else {
        const chainkLinkRelay = relay as ChainLinkRelay;
        const reserveBalances = iouTokens.map(iouToken => {
          const relevantPoolTokenData = chainkLinkRelay.anchor.poolTokens.find(
            poolToken =>
              compareString(poolToken.poolToken.contract, iouToken.id)
          )!;
          return {
            balance: iouToken.balance,
            reserveId: relevantPoolTokenData.reserveId
          };
        });
        return {
          relay: viewRelay,
          poolTokens: reserveBalances
        };
      }
    });
  }

  get morePoolsAvailable() {
    const allPools = this.registeredAnchorAddresses;
    const remainingPools = allPools
      .filter(
        poolAddress =>
          !this.relaysList.some(relay => compareString(poolAddress, relay.id))
      )
      .filter(
        poolAddress =>
          !this.failedPools.some(failedPool =>
            compareString(failedPool, poolAddress)
          )
      );
    return remainingPools.length > 0;
  }

  get currentEthNetwork() {
    return vxm.ethWallet.currentNetwork as EthNetworks;
  }

  @mutation setLoadingPools(status: boolean) {
    this.loadingPools = status;
  }

  @mutation updateFailedPools(ids: string[]) {
    this.failedPools = uniqWith([...this.failedPools, ...ids], compareString);
  }

  @action async loadMorePools() {
    this.setLoadingPools(true);
    const remainingAnchorAddresses = this.registeredAnchorAddresses
      .filter(
        address =>
          !this.relaysList.some(relay => compareString(relay.id, address))
      )
      .filter(
        address =>
          !this.failedPools.some(failedPoolAddress =>
            compareString(address, failedPoolAddress)
          )
      );

    if (remainingAnchorAddresses && remainingAnchorAddresses.length > 0) {
      const remainingPools = await this.addConvertersToAnchors(
        remainingAnchorAddresses
      );

      await this.addPoolsBulk(remainingPools);
    }
    this.setLoadingPools(false);
  }

  get secondaryReserveChoices(): ModalChoice[] {
    return this.newNetworkTokenChoices;
  }

  get primaryReserveChoices() {
    return (secondaryReserveId: string): ModalChoice[] => {
      const poolsWithReserve = this.relaysList.filter(
        reserveIncludedInRelay(secondaryReserveId)
      );
      const reserves = poolsWithReserve
        .flatMap(relay => relay.reserves)
        .filter(
          reserve => !compareString(reserve.contract, secondaryReserveId)
        );

      const modalChoices = reserves
        .filter(reserve =>
          this.tokens.some(token => compareString(token.id, reserve.contract))
        )
        .map(reserve =>
          viewTokenToModalChoice(
            this.tokens.find(token =>
              compareString(token.id, reserve.contract)
            )!
          )
        )
        .filter(
          token =>
            !this.secondaryReserveChoices.some(choice =>
              compareString(choice.id, token.id)
            )
        );

      return sortAlongSide(
        modalChoices,
        choice => choice.id.toLowerCase(),
        this.tokens.map(token => token.id.toLowerCase())
      );
    };
  }

  get newNetworkTokenChoices(): ModalChoice[] {
    const toOffer = [
      { symbolName: "BNT", value: this.bntUsdPrice },
      { symbolName: "USDB", value: 1 }
    ];

    const addedMeta = toOffer
      .map(offer => ({
        ...offer,
        meta: this.tokenMeta.find(meta => meta.symbol == offer.symbolName)!
      }))
      .filter(offer => offer.meta);

    return addedMeta.map(meta => ({
      id: meta.meta.id,
      contract: meta.meta.contract,
      img: meta.meta.image,
      symbol: meta.meta.symbol,
      balance:
        this.tokenBalance(meta.meta.contract) &&
        this.tokenBalance(meta.meta.contract)!.balance,
      usdValue: meta.value
    }));
  }

  get newPoolTokenChoices() {
    return (networkToken: string): ModalChoice[] => {
      const tokenChoices = this.tokenMeta
        .map(meta => metaToModalChoice(meta))
        .map(modalChoice => ({
          ...modalChoice,
          balance:
            this.tokenBalance(modalChoice.contract) &&
            this.tokenBalance(modalChoice.contract)!.balance
        }))
        .filter(meta =>
          this.newNetworkTokenChoices.some(
            networkChoice => !compareString(networkChoice.id, meta.id)
          )
        )
        .filter(tokenChoice => tokenChoice.id !== networkToken)
        .filter(meta => {
          const suggestedReserveIds = [meta.id, networkToken];
          const existingRelayWithSameReserves = this.relaysList.some(relay => {
            const reserves = relay.reserves.map(reserve => reserve.contract);
            return suggestedReserveIds.every(id =>
              reserves.some(r => compareString(id, r))
            );
          });
          return !existingRelayWithSameReserves;
        })
        .filter((_, index) => index < 200);

      const sorted = sortAlongSide(
        tokenChoices,
        token => token.id.toLowerCase(),
        this.tokens.map(token => token.id.toLowerCase())
      ).sort((a, b) => Number(b.balance) - Number(a.balance));
      return sorted;
    };
  }

  get isAuthenticated() {
    return vxm.wallet.isAuthenticated;
  }

  @mutation moduleInitiated() {
    this.initiated = true;
  }

  @action async fetchNewConverterAddressFromHash(
    hash: string
  ): Promise<string> {
    const interval = 1000;
    const attempts = 10;

    for (let i = 0; i < attempts; i++) {
      const info = await web3.eth.getTransactionReceipt(hash);
      if (info) {
        return removeLeadingZeros(info.logs[0].address);
      }
      await wait(interval);
    }
    throw new Error("Failed to find new address in decent time");
  }

  @action async fetchNewSmartContractAddressFromHash(
    hash: string
  ): Promise<string> {
    const interval = 1000;
    const attempts = 10;

    for (let i = 0; i < attempts; i++) {
      const info = await web3.eth.getTransactionReceipt(hash);
      console.log(info, "was info");
      if (info) {
        return info.contractAddress!;
      }
      await wait(interval);
    }
    throw new Error("Failed to find new address in decent time");
  }

  @mutation resetData() {
    this.relayFeed = [];
    this.relaysList = [];
    this.tokenBalances = [];
    this.initiated = false;
  }

  @action async onNetworkChange(updatedNetwork: EthNetworks) {
    if (this.currentNetwork !== updatedNetwork) {
      this.resetData();
      this.init();
    }
  }

  @action async deployConverter({
    smartTokenName,
    smartTokenSymbol,
    reserveTokenAddresses,
    precision = 18
  }: {
    smartTokenName: string;
    smartTokenSymbol: string;
    reserveTokenAddresses: string[];
    precision?: number;
  }): Promise<string> {
    if (reserveTokenAddresses.length !== 2)
      throw new Error("Method deployConverter only supports 2 reserves");
    const contract = buildRegistryContract(
      this.contracts.BancorConverterRegistry
    );

    const smartTokenDecimals = precision;

    return this.resolveTxOnConfirmation({
      tx: contract.methods.newConverter(
        1,
        smartTokenName,
        smartTokenSymbol,
        smartTokenDecimals,
        50000,
        reserveTokenAddresses,
        [500000, 500000]
      )
    });
  }

  @action async fetchHistoryData(poolId: string) {
    const pool = await this.relayById(poolId);
    const reserveSymbols = pool.reserves.map(reserve => reserve.symbol);
    const sortedSymbols = sortByNetworkTokens(reserveSymbols, x => x);
    const [networkToken, primaryReserveToken] = sortedSymbols;
    return getSmartTokenHistory(primaryReserveToken.toLowerCase());
  }

  @action async createPool(poolParams: CreatePoolParams) {
    if (poolParams.reserves.length !== 2)
      throw new Error("Was expecting two reserves in new pool");

    const [networkReserve, tokenReserve] = sortByNetworkTokens(
      poolParams.reserves,
      reserve => reserve.id,
      networkTokens.map(
        symbolName =>
          this.tokenMeta.find(meta => compareString(meta.symbol, symbolName))!
            .id
      )
    );

    const networkToken = findOrThrow(this.tokenMeta, meta =>
      compareString(meta.id, networkReserve.id)
    );
    const reserveToken = findOrThrow(this.tokenMeta, meta =>
      compareString(meta.id, tokenReserve.id)
    );

    const networkSymbol = networkToken.symbol;
    const tokenSymbol = reserveToken.symbol;

    const smartTokenName = `${tokenSymbol} Smart Pool Token`;
    const smartTokenSymbol = tokenSymbol + networkSymbol;
    const precision = 18;

    const hasFee = poolParams.fee > 0;

    const { reserves, txId } = (await multiSteps({
      items: [
        {
          description: "Deploying new Pool..",
          task: async () => {
            const reserves = await Promise.all(
              poolParams.reserves.map(async ({ id, amount: decAmount }) => {
                const token = findOrThrow(
                  this.tokenMeta,
                  meta => compareString(meta.id, id),
                  `failed finding ${id} in known token meta`
                );
                const decimals = await this.getDecimalsByTokenAddress(
                  token.contract
                );

                const res: WeiExtendedAsset = {
                  weiAmount: expandToken(decAmount, decimals),
                  contract: token.contract
                };
                return res;
              })
            );

            const converterRes = await this.deployConverter({
              reserveTokenAddresses: reserves.map(reserve => reserve.contract),
              smartTokenName,
              smartTokenSymbol,
              precision
            });

            const converterAddress = await this.fetchNewConverterAddressFromHash(
              converterRes
            );

            return {
              converterAddress,
              converterRes
            };
          }
        },
        {
          description:
            "Transferring ownership of pool and adding reserve allowances...",
          task: async (state?: any) => {
            const { converterAddress, reserves } = state as {
              converterAddress: string;
              reserves: WeiExtendedAsset[];
            };
            await Promise.all<any>([
              this.claimOwnership(converterAddress),
              ...reserves
                .filter(
                  reserve => !compareString(reserve.contract, ethReserveAddress)
                )
                .map(reserve =>
                  this.triggerApprovalIfRequired({
                    owner: this.isAuthenticated,
                    amount: reserve.weiAmount,
                    tokenAddress: reserve.contract,
                    spender: converterAddress
                  })
                )
            ]);
          }
        },
        {
          description: `Adding reserve liquidity ${
            hasFee ? "and setting fee..." : ""
          }`,
          task: async (state?: any) => {
            const { converterAddress, reserves } = state as {
              converterAddress: string;
              reserves: WeiExtendedAsset[];
            };

            await Promise.all<any>([
              ...[
                hasFee
                  ? this.setFee({
                      converterAddress,
                      decFee: Number(poolParams.fee)
                    })
                  : []
              ],
              this.addLiquidityV28({
                converterAddress,
                reserves: reserves.map(reserve => ({
                  tokenContract: reserve.contract,
                  weiAmount: reserve.weiAmount
                })),
                minimumReturnWei: "1"
              })
            ]);
          }
        }
      ],
      onUpdate: poolParams.onUpdate
    })) as { reserves: WeiExtendedAsset[]; txId: string };

    this.spamBalances(reserves.map(reserve => reserve.contract));
    wait(5000).then(() => this.init());

    return txId;
  }

  @action async approveTokenWithdrawals(
    approvals: {
      approvedAddress: string;
      amount: string;
      tokenAddress: string;
    }[]
  ) {
    return Promise.all(
      approvals.map(approval => {
        const tokenContract = buildTokenContract(approval.tokenAddress);

        return this.resolveTxOnConfirmation({
          tx: tokenContract.methods.approve(
            approval.approvedAddress,
            approval.amount
          ),
          gas: 70000
        });
      })
    );
  }

  @action async claimOwnership(converterAddress: string) {
    const converter = buildConverterContract(converterAddress);

    return this.resolveTxOnConfirmation({
      tx: converter.methods.acceptOwnership()
    });
  }

  @action async setFee({
    converterAddress,
    decFee
  }: {
    converterAddress: string;
    decFee: number;
  }) {
    const converterContract = buildConverterContract(converterAddress);

    const ppm = decFee * 1000000;
    // @ts-ignore
    return this.resolveTxOnConfirmation({
      tx: converterContract.methods.setConversionFee(ppm),
      resolveImmediately: true
    });
  }

  @action async resolveTxOnConfirmation({
    tx,
    gas,
    value,
    resolveImmediately = false,
    onHash
  }: {
    tx: ContractSendMethod;
    value?: string;
    gas?: number;
    resolveImmediately?: boolean;
    onHash?: (hash: string) => void;
  }): Promise<string> {
    console.log("received", tx);
    return new Promise((resolve, reject) => {
      let txHash: string;
      tx.send({
        from: this.isAuthenticated,
        ...(gas && { gas }),
        ...(value && { value: toHex(value) })
      })
        .on("transactionHash", (hash: string) => {
          txHash = hash;
          if (onHash) onHash(hash);
          if (resolveImmediately) {
            resolve(txHash);
          }
        })
        .on("confirmation", (confirmationNumber: number) => {
          resolve(txHash);
        })
        .on("error", (error: any) => reject(error));
    });
  }

  @action async addReserveToken({
    converterAddress,
    reserveTokenAddress
  }: {
    converterAddress: string;
    reserveTokenAddress: string;
  }) {
    const converter = buildConverterContract(converterAddress);

    return this.resolveTxOnConfirmation({
      tx: converter.methods.addReserve(reserveTokenAddress, 500000)
    });
  }

  get supportedFeatures() {
    return (symbolName: string) => {
      return ["addLiquidity", "removeLiquidity"];
    };
  }

  get wallet() {
    return "eth";
  }

  get tokens(): ViewToken[] {
    console.time("tokens");
    const ret = this.relaysList
      .filter(relay =>
        relay.reserves.every(reserve =>
          this.relayFeed.some(
            relayFeed =>
              compareString(relayFeed.tokenId, reserve.contract) &&
              compareString(relayFeed.poolId, relay.id)
          )
        )
      )
      .flatMap(relay =>
        relay.reserves.map(reserve => {
          const { name, image } = this.tokenMetaObj(reserve.contract);
          const relayFeed = this.relayFeed
            .slice()
            .sort(sortFeedByExtraProps)
            .find(
              feed =>
                compareString(feed.poolId, relay.id) &&
                compareString(feed.tokenId, reserve.contract)
            )!;
          const balance = this.tokenBalance(reserve.contract);
          return {
            id: reserve.contract,
            precision: reserve.decimals,
            symbol: reserve.symbol,
            name,
            ...(relayFeed.costByNetworkUsd && {
              price: relayFeed.costByNetworkUsd
            }),
            liqDepth: relayFeed.liqDepth,
            logo: image,
            ...(relayFeed.change24H && { change24h: relayFeed.change24H }),
            ...(relayFeed.volume24H && { volume24h: relayFeed.volume24H }),
            ...(balance && { balance: balance.balance })
          };
        })
      )
      .sort(sortByLiqDepth)
      .reduce<ViewToken[]>((acc, item) => {
        const existingToken = acc.find(token =>
          compareString(token.id!, item.id)
        );
        return existingToken
          ? updateArray(
              acc,
              token =>
                compareString(token.id!, item.id) && !isNaN(item.liqDepth),
              token => ({ ...token, liqDepth: token.liqDepth! + item.liqDepth })
            )
          : [...acc, item as ViewToken];
      }, []);
    console.timeEnd("tokens");
    return ret;
  }

  get tokenMetaObj() {
    return (id: string) => {
      return findOrThrow(
        this.tokenMeta,
        meta => compareString(id, meta.id),
        `Failed to find token meta for symbol with token contract of ${id}`
      );
    };
  }

  get tokenBalance() {
    return (tokenId: string) =>
      this.tokenBalances.find(token => compareString(token.id, tokenId));
  }

  get token(): (arg0: string) => any {
    return (id: string) =>
      findOrThrow(
        this.tokens,
        token => compareString(token.id, id),
        `failed to find token() with ID ${id} ethBancor`
      );
  }

  get relay() {
    return (id: string) =>
      findOrThrow(
        this.relays,
        relay => compareString(relay.id, id),
        `failed to find relay with id of ${id} in eth relay getter`
      );
  }

  get relays(): ViewRelay[] {
    console.time("relays");
    const toReturn = [...this.chainkLinkRelays, ...this.traditionalRelays]
      .sort(sortByLiqDepth)
      .sort((a, b) => {
        if (a.v2 && b.v2) return 0;
        if (!a.v2 && !b.v2) return 0;
        if (a.v2 && !b.v2) return -1;
        if (!a.v2 && b.v2) return 1;
        return 0;
      });
    console.timeEnd("relays");
    return toReturn;
  }

  get chainkLinkRelays(): ViewRelay[] {
    return (this.relaysList.filter(isChainLink) as ChainLinkRelay[])
      .filter(relay =>
        this.relayFeed.some(feed => compareString(feed.poolId, relay.id))
      )
      .map(relay => {
        const [networkReserve, tokenReserve] = sortByNetworkTokens(
          relay.reserves,
          reserve => reserve.symbol
        );
        const relayFeed = this.relayFeed
          .slice()
          .sort(sortFeedByExtraProps)
          .find(feed => compareString(feed.poolId, relay.id))!;

        const { poolContainerAddress } = relay.anchor;

        return {
          id: poolContainerAddress,
          reserves: [networkReserve, tokenReserve].map(reserve => {
            const meta = this.tokenMetaObj(reserve.contract);
            return {
              reserveWeight: reserve.reserveWeight,
              id: reserve.contract,
              reserveId: poolContainerAddress + reserve.contract,
              logo: [meta.image],
              symbol: reserve.symbol,
              contract: reserve.contract,
              smartTokenSymbol: poolContainerAddress
            };
          }),
          fee: relay.fee / 100,
          liqDepth: relayFeed.liqDepth,
          owner: relay.owner,
          symbol: tokenReserve.symbol,
          addLiquiditySupported: true,
          removeLiquiditySupported: true,
          focusAvailable: false,
          v2: true
        } as ViewRelay;
      });
  }

  get traditionalRelays(): ViewRelay[] {
    return (this.relaysList.filter(isTraditional) as TraditionalRelay[])
      .filter(relay =>
        this.relayFeed.some(feed => compareString(feed.poolId, relay.id))
      )
      .map(relay => {
        const [networkReserve, tokenReserve] = sortByNetworkTokens(
          relay.reserves,
          reserve => reserve.symbol
        );
        const relayFeed = this.relayFeed
          .slice()
          .sort(sortFeedByExtraProps)
          .find(feed => compareString(feed.poolId, relay.id))!;

        const smartTokenSymbol = relay.anchor.symbol;
        const hasHistory = this.availableHistories.some(history =>
          compareString(smartTokenSymbol, history)
        );

        return {
          id: relay.anchor.contract,
          reserves: [networkReserve, tokenReserve].map(reserve => {
            const meta = this.tokenMetaObj(reserve.contract);
            return {
              id: reserve.contract,
              reserveWeight: reserve.reserveWeight,
              reserveId: relay.anchor.contract + reserve.contract,
              logo: [meta.image],
              symbol: reserve.symbol,
              contract: reserve.contract,
              smartTokenSymbol: relay.anchor.contract
            };
          }),
          fee: relay.fee / 100,
          liqDepth: relayFeed.liqDepth,
          owner: relay.owner,
          symbol: tokenReserve.symbol,
          addLiquiditySupported: true,
          removeLiquiditySupported: true,
          focusAvailable: hasHistory,
          v2: false
        } as ViewRelay;
      });
  }

  @mutation setTokenMeta(tokenMeta: TokenMeta[]) {
    this.tokenMeta = tokenMeta;
  }

  @action async triggerTx(actions: any[]) {
    // @ts-ignore
    return this.$store.dispatch("ethWallet/tx", actions, { root: true });
  }

  @action async fetchRelayBalances(poolId: string) {
    const { reserves, version, contract } = await this.relayById(poolId);

    const converterContract = buildConverterContract(contract);
    const smartTokenContract = buildTokenContract(poolId);

    const [reserveBalances, smartTokenSupplyWei] = await Promise.all([
      Promise.all(
        reserves.map(reserve =>
          fetchReserveBalance(converterContract, reserve.contract, version)
        )
      ),
      smartTokenContract.methods.totalSupply().call()
    ]);

    return {
      reserves: reserves.map((reserve, index) => ({
        ...reserve,
        weiAmount: reserveBalances[index]
      })),
      smartTokenSupplyWei
    };
  }

  @action async calculateOpposingDepositInfo(
    opposingDeposit: OpposingLiquidParams
  ): Promise<EthOpposingLiquid> {
    const { id, reserve } = opposingDeposit;
    const relay = await this.traditionalRelayById(id);

    const reserveToken = await this.tokenById(reserve.id);

    const tokenSymbol = reserveToken.symbol;
    const tokenAmount = reserve.amount;

    const smartTokenAddress = relay.anchor.contract;
    const smartTokenDecimals = relay.anchor.decimals;

    const { reserves, smartTokenSupplyWei } = await this.fetchRelayBalances(
      smartTokenAddress
    );

    const [sameReserve, opposingReserve] = sortByNetworkTokens(
      reserves,
      reserve => reserve.symbol,
      [tokenSymbol]
    );

    const sameReserveWei = expandToken(tokenAmount, sameReserve.decimals);

    const opposingAmount = calculateOppositeFundRequirement(
      sameReserveWei,
      sameReserve.weiAmount,
      opposingReserve.weiAmount
    );
    const fundReward = calculateFundReward(
      sameReserveWei,
      sameReserve.weiAmount,
      smartTokenSupplyWei
    );

    const fundRewardDec = Number(shrinkToken(fundReward, smartTokenDecimals));
    const smartSupplyDec = Number(
      shrinkToken(smartTokenSupplyWei, smartTokenDecimals)
    );
    const shareOfPool = fundRewardDec / smartSupplyDec;

    const sameReserveCostDec = new BigNumber(opposingReserve.weiAmount)
      .div(sameReserve.weiAmount)
      .toString();

    const opposingReserveCostDec = new BigNumber(sameReserve.weiAmount)
      .div(opposingReserve.weiAmount)
      .toString();

    console.log(
      opposingReserve.weiAmount,
      sameReserve.weiAmount,
      "should be wei amounts",
      sameReserveCostDec,
      opposingReserveCostDec
    );

    const res = {
      opposingAmount: shrinkToken(opposingAmount, opposingReserve.decimals),
      smartTokenAmount: { id: smartTokenAddress, amount: fundReward },
      shareOfPool,
      singleUnitCosts: [
        { id: sameReserve.contract, amount: sameReserveCostDec },
        { id: opposingReserve.contract, amount: opposingReserveCostDec }
      ]
    };
    console.log("v1 add liquidity sending back", res);
    return res;
  }

  @action async opposingReserveChangeNotRequired(poolId: string) {
    if (poolId == "0xb1CD6e4153B2a390Cf00A6556b0fC1458C4A5533") {
      console.warn("not going to bother changing!");
      return true;
    }

    const poolType = await this.getPoolType(poolId);
    return poolType == PoolType.ChainLink;
  }

  @action async calculateOpposingDepositV2(
    opposingDeposit: OpposingLiquidParams
  ): Promise<OpposingLiquid> {
    const relay = await this.chainLinkRelayById(opposingDeposit.id);

    const suggestedDepositDec = opposingDeposit.reserve.amount;

    const [[stakedAndReserveWeight]] = (await this.smartMulti([
      stakedAndReserveHandler([
        {
          converterAdress: relay.contract,
          reserveOne: relay.reserves[0].contract,
          reserveTwo: relay.reserves[1].contract
        }
      ])
    ])) as [StakedAndReserve[]];

    const [biggerWeight, smallerWeight] = stakedAndReserveWeight.reserves
      .map(reserve => ({
        ...reserve,
        decReserveWeight: new BigNumber(reserve.reserveWeight).div(oneMillion),
        token: findOrThrow(relay.reserves, r =>
          compareString(r.contract, reserve.reserveAddress)
        )
      }))
      .sort((a, b) => b.decReserveWeight.minus(a.reserveWeight).toNumber());

    const weightsEqualOneMillion = new BigNumber(biggerWeight.reserveWeight)
      .plus(smallerWeight.reserveWeight)
      .eq(oneMillion);
    if (!weightsEqualOneMillion)
      throw new Error("Was expecting reserve weights to equal 100%");
    const distanceFromMiddle = biggerWeight.decReserveWeight.minus(0.5);

    const adjustedBiggerWeight = new BigNumber(biggerWeight.stakedBalance).div(
      new BigNumber(1).minus(distanceFromMiddle)
    );
    const adjustedSmallerWeight = new BigNumber(
      smallerWeight.stakedBalance
    ).div(new BigNumber(1).plus(distanceFromMiddle));

    const singleUnitCosts = [
      {
        id: biggerWeight.reserveAddress,
        amount: shrinkToken(
          adjustedBiggerWeight.toString(),
          biggerWeight.token.decimals
        )
      },
      {
        id: smallerWeight.reserveAddress,
        amount: shrinkToken(
          adjustedSmallerWeight.toString(),
          smallerWeight.token.decimals
        )
      }
    ];

    const sameReserve = findOrThrow([biggerWeight, smallerWeight], weight =>
      compareString(weight.reserveAddress, opposingDeposit.reserve.id)
    );

    const shareOfPool =
      Number(opposingDeposit.reserve.amount) /
      Number(
        shrinkToken(sameReserve.stakedBalance, sameReserve.token.decimals)
      );

    const suggestedDepositWei = expandToken(
      suggestedDepositDec,
      sameReserve.token.decimals
    );

    const v2Converter = buildV2Converter(relay.contract);
    const maxStakingEnabled = await v2Converter.methods
      .maxStakedBalanceEnabled()
      .call();
    console.log({ maxStakingEnabled });
    if (maxStakingEnabled) {
      const maxStakedBalance = await v2Converter.methods
        .maxStakedBalances(sameReserve.reserveAddress)
        .call();

      console.log({ maxStakedBalance });
      if (maxStakedBalance !== "0") {
        const currentBalance = new BigNumber(sameReserve.stakedBalance);
        const proposedTotalBalance = new BigNumber(suggestedDepositWei).plus(
          currentBalance
        );
        const maxStakedBalanceWei = new BigNumber(maxStakedBalance);
        if (proposedTotalBalance.gt(maxStakedBalanceWei)) {
          const remainingSpaceAvailableWei = maxStakedBalanceWei.minus(
            currentBalance
          );
          const remainingSpaceAvailableDec = shrinkToken(
            remainingSpaceAvailableWei.toString(),
            sameReserve.token.decimals
          );
          if (remainingSpaceAvailableWei.isLessThanOrEqualTo(0))
            throw new Error("This pool has reached the max liquidity cap");
          throw new Error(
            `This pool is currently capped and can receive ${remainingSpaceAvailableDec} additional tokens`
          );
        }
      }
    }

    const result = {
      opposingAmount: undefined,
      shareOfPool,
      singleUnitCosts
    };
    console.log(result, "was the result");
    return result;
  }

  @action async calculateOpposingDeposit(
    opposingDeposit: OpposingLiquidParams
  ): Promise<OpposingLiquid> {
    const relay = await this.relayById(opposingDeposit.id);

    if (relay.converterType == PoolType.ChainLink) {
      return this.calculateOpposingDepositV2(opposingDeposit);
    } else {
      return this.calculateOpposingDepositInfo(opposingDeposit);
    }
  }

  @action async getUserBalance({
    tokenContractAddress,
    userAddress,
    keepWei = false
  }: {
    tokenContractAddress: string;
    userAddress?: string;
    keepWei?: boolean;
  }) {
    if (!tokenContractAddress)
      throw new Error("Token contract address cannot be falsy");
    const balance = await vxm.ethWallet.getBalance({
      accountHolder: userAddress || vxm.wallet.isAuthenticated,
      tokenContractAddress,
      keepWei
    });
    const currentBalance = this.tokenBalance(tokenContractAddress);
    if (currentBalance && currentBalance.balance !== balance) {
      this.updateBalance([tokenContractAddress, Number(balance)]);
    }
    if (Number(balance) > 0) {
      this.updateBalance([tokenContractAddress, Number(balance)]);
    }
    return balance;
  }

  @action async relayById(relayId: string) {
    return findOrThrow(this.relaysList, relay =>
      compareString(relay.id, relayId)
    );
  }

  @action async getUserBalancesTraditional({
    relayId,
    smartTokenDec
  }: {
    relayId: string;
    smartTokenDec?: number;
  }): Promise<UserPoolBalances> {
    const relay = await this.traditionalRelayById(relayId);

    const smartTokenUserBalance =
      smartTokenDec ||
      (await this.getUserBalance({
        tokenContractAddress: relay.anchor.contract
      }));

    const { smartTokenSupplyWei, reserves } = await this.fetchRelayBalances(
      relay.anchor.contract
    );

    const smartTokenDecimals = relay.anchor.decimals;

    const percent = new Decimal(smartTokenUserBalance).div(
      shrinkToken(smartTokenSupplyWei, smartTokenDecimals)
    );

    const maxWithdrawals: ViewAmount[] = reserves.map(reserve => ({
      id: reserve.contract,
      amount: shrinkToken(
        percent.times(reserve.weiAmount).toString(),
        reserve.decimals
      )
    }));

    return {
      maxWithdrawals,
      iouBalances: [{ id: "", amount: String(smartTokenUserBalance) }]
    };
  }

  @action async getPoolType(pool: string | Relay): Promise<PoolType> {
    let relay: Relay;
    if (typeof pool == "undefined") {
      throw new Error("Pool is undefined");
    } else if (typeof pool == "string") {
      const poolId = pool as string;
      relay = await this.relayById(poolId);
    } else {
      relay = pool as Relay;
    }
    return typeof relay.converterType !== "undefined" &&
      relay.converterType == PoolType.ChainLink
      ? PoolType.ChainLink
      : PoolType.Traditional;
  }

  @action async removeLiquidityReturn({
    converterAddress,
    poolTokenWei,
    poolTokenContract
  }: {
    converterAddress: string;
    poolTokenWei: string;
    poolTokenContract: string;
  }) {
    const v2Converter = buildV2Converter(converterAddress);

    const res = await v2Converter.methods
      .removeLiquidityReturnAndFee(poolTokenContract, poolTokenWei)
      .call();

    return { feeAmountWei: res[1], returnAmountWei: res[0] };
  }

  @action async getUserBalancesChainLink(
    relayId: string
  ): Promise<UserPoolBalances> {
    const relay = await this.chainLinkRelayById(relayId);
    const poolTokenBalances = await Promise.all(
      relay.anchor.poolTokens.map(async reserveAndPool => {
        const poolUserBalance = await this.getUserBalance({
          tokenContractAddress: reserveAndPool.poolToken.contract,
          keepWei: false
        });

        BigNumber.config({ EXPONENTIAL_AT: 256 });

        return {
          ...reserveAndPool,
          poolUserBalance: Number(poolUserBalance),
          reserveToken: findOrThrow(relay.reserves, reserve =>
            compareString(reserve.contract, reserveAndPool.reserveId)
          )
        };
      })
    );

    const v2Converter = buildV2Converter(relay.contract);
    const data = await Promise.all(
      poolTokenBalances.map(async poolTokenBalance => {
        const poolTokenBalanceWei = expandToken(
          poolTokenBalance.poolUserBalance,
          poolTokenBalance.poolToken.decimals
        );

        const maxWithdrawWei = (await v2Converter.methods
          .removeLiquidityReturnAndFee(
            poolTokenBalance.poolToken.contract,
            poolTokenBalanceWei
          )
          .call())[0];

        return {
          ...poolTokenBalance,
          maxWithdraw: shrinkToken(
            maxWithdrawWei,
            poolTokenBalance.reserveToken.decimals
          )
        };
      })
    );

    const maxWithdrawals = data.map(
      (x): ViewAmount => ({
        id: x.reserveId,
        amount: String(x.maxWithdraw)
      })
    );

    const iouBalances = data.map(
      (x): ViewAmount => ({
        id: x.reserveId,
        amount: new BigNumber(x.poolUserBalance).toString()
      })
    );

    console.log({ iouBalances, maxWithdrawals });

    return { iouBalances, maxWithdrawals };
  }

  @action async getUserBalances(relayId: string): Promise<UserPoolBalances> {
    if (!vxm.wallet.isAuthenticated)
      throw new Error("Cannot find users .isAuthenticated");

    const poolType = await this.getPoolType(relayId);
    console.log("detected pool type is", poolType);
    return poolType == PoolType.Traditional
      ? this.getUserBalancesTraditional({ relayId })
      : this.getUserBalancesChainLink(relayId);
  }

  @action async getTokenSupply(tokenAddress: string) {
    const contract = buildTokenContract(tokenAddress);
    return contract.methods.totalSupply().call();
  }

  @action async calculateOpposingWithdrawV2(
    opposingWithdraw: OpposingLiquidParams
  ): Promise<OpposingLiquid> {
    const relay = await this.chainLinkRelayById(opposingWithdraw.id);

    const suggestedWithdrawDec = opposingWithdraw.reserve.amount;

    const [[stakedAndReserveWeight]] = (await this.smartMulti([
      stakedAndReserveHandler([
        {
          converterAdress: relay.contract,
          reserveOne: relay.reserves[0].contract,
          reserveTwo: relay.reserves[1].contract
        }
      ])
    ])) as [StakedAndReserve[]];

    const [biggerWeight, smallerWeight] = stakedAndReserveWeight.reserves
      .map(reserve => ({
        ...reserve,
        decReserveWeight: new BigNumber(reserve.reserveWeight).div(oneMillion),
        token: findOrThrow(relay.reserves, r =>
          compareString(r.contract, reserve.reserveAddress)
        )
      }))
      .sort((a, b) => b.decReserveWeight.minus(a.reserveWeight).toNumber());

    const weightsEqualOneMillion = new BigNumber(biggerWeight.reserveWeight)
      .plus(smallerWeight.reserveWeight)
      .eq(oneMillion);
    if (!weightsEqualOneMillion)
      throw new Error("Was expecting reserve weights to equal 100%");
    const distanceFromMiddle = biggerWeight.decReserveWeight.minus(0.5);

    const adjustedBiggerWeight = new BigNumber(biggerWeight.stakedBalance).div(
      new BigNumber(1).minus(distanceFromMiddle)
    );
    const adjustedSmallerWeight = new BigNumber(
      smallerWeight.stakedBalance
    ).div(new BigNumber(1).plus(distanceFromMiddle));

    const singleUnitCosts = [
      {
        id: biggerWeight.reserveAddress,
        amount: shrinkToken(
          adjustedBiggerWeight.toString(),
          biggerWeight.token.decimals
        )
      },
      {
        id: smallerWeight.reserveAddress,
        amount: shrinkToken(
          adjustedSmallerWeight.toString(),
          smallerWeight.token.decimals
        )
      }
    ];

    const sameReserve = findOrThrow([biggerWeight, smallerWeight], weight =>
      compareString(weight.reserveAddress, opposingWithdraw.reserve.id)
    );

    const shareOfPool =
      Number(opposingWithdraw.reserve.amount) /
      Number(
        shrinkToken(sameReserve.stakedBalance, sameReserve.token.decimals)
      );

    const suggestedWithdrawWei = expandToken(
      suggestedWithdrawDec,
      sameReserve.token.decimals
    );

    const [
      { returnAmountWei, feeAmountWei },
      liquidatationLimit
    ] = await Promise.all([
      this.removeLiquidityReturn({
        converterAddress: relay.contract,
        poolTokenContract: sameReserve.poolTokenAddress,
        poolTokenWei: suggestedWithdrawWei
      }),
      liquidationLimit({
        converterContract: relay.contract,
        poolTokenAddress: sameReserve.poolTokenAddress
      })
    ]);

    if (new BigNumber(suggestedWithdrawWei).gt(liquidatationLimit))
      throw new Error("Withdrawal amount above current liquidation limit");

    const noFeeLiquidityReturn = new BigNumber(returnAmountWei).plus(
      feeAmountWei
    );

    console.log({ returnAmountWei, feeAmountWei }, "xxx");

    const feePercent = new BigNumber(feeAmountWei)
      .div(noFeeLiquidityReturn)
      .toNumber();

    const removeLiquidityReturnDec = shrinkToken(
      returnAmountWei,
      sameReserve.token.decimals
    );

    const result = {
      opposingAmount: undefined,
      shareOfPool,
      singleUnitCosts,
      withdrawFee: feePercent,
      expectedReturn: {
        id: sameReserve.token.contract,
        amount: String(Number(removeLiquidityReturnDec))
      }
    };
    console.log(result, "was the result");
    return result;
  }

  @action async calculateOpposingWithdraw(
    opposingWithdraw: OpposingLiquidParams
  ): Promise<OpposingLiquid> {
    const relay = await this.relayById(opposingWithdraw.id);
    if (relay.converterType == PoolType.ChainLink) {
      return this.calculateOpposingWithdrawV2(opposingWithdraw);
    } else {
      return this.calculateOpposingWithdrawInfo(opposingWithdraw);
    }
  }

  @action async traditionalRelayById(
    poolId: string
  ): Promise<TraditionalRelay> {
    const relay = await this.relayById(poolId);
    const traditionalRelay = assertTraditional(relay);
    return traditionalRelay;
  }

  @action async chainLinkRelayById(poolId: string): Promise<ChainLinkRelay> {
    const relay = await this.relayById(poolId);
    const chainlinkRelay = assertChainlink(relay);
    return chainlinkRelay;
  }

  @action async calculateOpposingWithdrawInfo(
    opposingWithdraw: OpposingLiquidParams
  ): Promise<EthOpposingLiquid> {
    const { id, reserve } = opposingWithdraw;
    const tokenAmount = reserve.amount;
    const sameReserveToken = await this.tokenById(reserve.id);

    const relay = await this.traditionalRelayById(id);
    const smartTokenAddress = relay.anchor.contract;

    const { reserves, smartTokenSupplyWei } = await this.fetchRelayBalances(
      smartTokenAddress
    );

    const [sameReserve, opposingReserve] = sortByNetworkTokens(
      reserves,
      reserve => reserve.symbol,
      [sameReserveToken.symbol]
    );

    const sameReserveWei = expandToken(tokenAmount, sameReserve.decimals);
    const shareOfPool = new BigNumber(sameReserveWei)
      .div(new BigNumber(sameReserve.weiAmount))
      .toNumber();

    const opposingValue = calculateOppositeLiquidateRequirement(
      sameReserveWei,
      sameReserve.weiAmount,
      opposingReserve.weiAmount
    );
    const liquidateCost = calculateLiquidateCost(
      sameReserveWei,
      sameReserve.weiAmount,
      smartTokenSupplyWei
    );

    const smartUserBalance = await vxm.ethWallet.getBalance({
      accountHolder: vxm.wallet.isAuthenticated,
      tokenContractAddress: smartTokenAddress,
      keepWei: true
    });

    const percentDifferenceBetweenSmartBalance = percentDifference(
      liquidateCost,
      String(smartUserBalance)
    );
    let smartTokenAmount: string;
    if (percentDifferenceBetweenSmartBalance > 0.99) {
      smartTokenAmount = String(smartUserBalance);
    } else {
      smartTokenAmount = liquidateCost;
    }

    const sameReserveCost = shrinkToken(
      new BigNumber(opposingReserve.weiAmount)
        .div(sameReserve.weiAmount)
        .toString(),
      sameReserve.decimals
    );
    const opposingReserveCost = shrinkToken(
      new BigNumber(sameReserve.weiAmount)
        .div(opposingReserve.weiAmount)
        .toString(),
      opposingReserve.decimals
    );

    return {
      opposingAmount: shrinkToken(opposingValue, opposingReserve.decimals),
      shareOfPool,
      smartTokenAmount: {
        id: smartTokenAddress,
        amount: smartTokenAmount
      },
      singleUnitCosts: [
        { id: sameReserve.contract, amount: sameReserveCost },
        { id: opposingReserve.contract, amount: opposingReserveCost }
      ]
    };
  }

  @action async removeLiquidityV2({
    converterAddress,
    poolToken,
    miniumReserveReturnWei = "1",
    onHash
  }: {
    converterAddress: string;
    poolToken: TokenWei;
    miniumReserveReturnWei: string;
    onHash?: (hash: string) => void;
  }) {
    const contract = buildV2Converter(converterAddress);

    return this.resolveTxOnConfirmation({
      tx: contract.methods.removeLiquidity(
        poolToken.tokenContract,
        poolToken.weiAmount,
        miniumReserveReturnWei
      ),
      onHash
    });
  }

  @action async liquidate({
    converterAddress,
    smartTokenAmount
  }: {
    converterAddress: string;
    smartTokenAmount: string;
  }) {
    const converterContract = buildConverterContract(converterAddress);

    return this.resolveTxOnConfirmation({
      tx: converterContract.methods.liquidate(smartTokenAmount)
    });
  }

  @action async removeLiquidity({ reserves, id: relayId }: LiquidityParams) {
    const relay = await this.relayById(relayId);

    const preV11 = Number(relay.version) < 11;
    if (preV11)
      throw new Error("This Pool is not supported for adding liquidity");

    const postV28 = Number(relay.version) >= 28;

    const withdraw = reserves.find(reserve => reserve.amount)!;
    const converterAddress = relay.contract;

    let hash: string;
    if (postV28 && relay.converterType == PoolType.ChainLink) {
      const v2Relay = await this.chainLinkRelayById(relayId);
      const poolToken = findOrThrow(v2Relay.anchor.poolTokens, poolToken =>
        compareString(poolToken.reserveId, withdraw.id)
      );

      const poolTokenWeiAmount = expandToken(
        withdraw.amount,
        poolToken.poolToken.decimals
      );
      const weiPoolTokenBalance = (await this.getUserBalance({
        tokenContractAddress: poolToken.poolToken.contract,
        keepWei: true
      })) as string;

      const roundedWeiAmount = new BigNumber(poolTokenWeiAmount).gt(
        new BigNumber(weiPoolTokenBalance).times(0.995)
      )
        ? weiPoolTokenBalance
        : poolTokenWeiAmount;

      const expectedReserveReturn = await this.removeLiquidityReturn({
        converterAddress: relay.contract,
        poolTokenWei: roundedWeiAmount,
        poolTokenContract: poolToken.poolToken.contract
      });

      hash = await this.removeLiquidityV2({
        converterAddress,
        poolToken: {
          tokenContract: poolToken.poolToken.contract,
          weiAmount: roundedWeiAmount
        },
        miniumReserveReturnWei: new BigNumber(
          expectedReserveReturn.returnAmountWei
        )
          .times(0.99)
          .toFixed(0)
      });
    } else if (postV28 && relay.converterType == PoolType.Traditional) {
      const traditionalRelay = await this.traditionalRelayById(relay.id);
      const { smartTokenAmount } = await this.calculateOpposingWithdrawInfo({
        id: relayId,
        reserve: reserves[0]
      });
      const userPoolBalance = await this.getUserBalancesTraditional({
        relayId,
        smartTokenDec: Number(
          shrinkToken(smartTokenAmount.amount, traditionalRelay.anchor.decimals)
        )
      });
      hash = await this.removeLiquidityV28({
        converterAddress,
        smartTokensWei: smartTokenAmount.amount,
        reserveTokens: relay.reserves.map(reserve => {
          const reserveBalances = userPoolBalance.maxWithdrawals;
          return {
            tokenAddress: reserve.contract,
            minimumReturnWei: expandToken(
              Number(
                reserveBalances.find(balance =>
                  compareString(balance.id, reserve.contract)
                )!.amount
              ) * 0.98,
              reserve.decimals
            )
          };
        })
      });
    } else {
      const { smartTokenAmount } = await this.calculateOpposingWithdrawInfo({
        id: relayId,
        reserve: reserves[0]
      });
      hash = await this.liquidate({
        converterAddress,
        smartTokenAmount: smartTokenAmount.amount
      });
    }

    const anchorTokens = getAnchorTokenAddresses(relay);

    const tokenAddressesChanged = [
      ...relay.reserves.map(reserve => reserve.contract),
      ...anchorTokens
    ];
    this.spamBalances(tokenAddressesChanged);

    return hash;
  }

  @action async mintEthErc(ethDec: string) {
    return new Promise((resolve, reject) => {
      let txHash: string;
      web3.eth
        .sendTransaction({
          from: this.isAuthenticated,
          to: ethErc20WrapperContract,
          value: toHex(toWei(ethDec))
        })
        .on("transactionHash", (hash: string) => {
          txHash = hash;
        })
        .on("confirmation", (confirmationNumber: number) => {
          resolve(txHash);
        })
        .on("error", (error: any) => reject(error));
    });
  }

  @action async fundRelay({
    converterAddress,
    fundAmount,
    onHash
  }: {
    converterAddress: string;
    fundAmount: string;
    onHash?: (hash: string) => void;
  }) {
    const converterContract = buildConverterContract(converterAddress);
    return this.resolveTxOnConfirmation({
      tx: converterContract.methods.fund(fundAmount),
      gas: 950000,
      ...(onHash && { onHash })
    });
  }

  @action async addLiquidityV28({
    converterAddress,
    reserves,
    minimumReturnWei,
    onHash
  }: {
    converterAddress: string;
    reserves: TokenWei[];
    minimumReturnWei: string;
    onHash?: (hash: string) => void;
  }) {
    const contract = buildV28ConverterContract(converterAddress);

    const newEthReserve = reserves.find(reserve =>
      compareString(reserve.tokenContract, ethReserveAddress)
    );

    return this.resolveTxOnConfirmation({
      tx: contract.methods.addLiquidity(
        reserves.map(reserve => reserve.tokenContract),
        reserves.map(reserve => reserve.weiAmount),
        minimumReturnWei
      ),
      onHash,
      ...(newEthReserve && { value: newEthReserve.weiAmount })
    });
  }

  @action async addLiquidityV2({
    converterAddress,
    reserve,
    poolTokenMinReturnWei = "1",
    onHash
  }: {
    converterAddress: string;
    reserve: TokenWei;
    poolTokenMinReturnWei?: string;
    onHash?: (hash: string) => void;
  }) {
    const contract = buildV2Converter(converterAddress);

    const newEthReserve = compareString(
      reserve.tokenContract,
      ethReserveAddress
    );

    return this.resolveTxOnConfirmation({
      tx: contract.methods.addLiquidity(
        reserve.tokenContract,
        reserve.weiAmount,
        poolTokenMinReturnWei
      ),
      onHash: onHash,
      ...(newEthReserve && { value: reserve.weiAmount })
    });
  }

  @action async removeLiquidityV28({
    converterAddress,
    smartTokensWei,
    reserveTokens
  }: {
    converterAddress: string;
    smartTokensWei: string;
    reserveTokens: { tokenAddress: string; minimumReturnWei: string }[];
  }) {
    const contract = buildV28ConverterContract(converterAddress);

    return this.resolveTxOnConfirmation({
      tx: contract.methods.removeLiquidity(
        smartTokensWei,
        reserveTokens.map(token => token.tokenAddress),
        reserveTokens.map(token => token.minimumReturnWei)
      )
    });
  }

  @action async addLiquidity({
    id: relayId,
    reserves,
    onUpdate
  }: LiquidityParams) {
    const relay = await this.relayById(relayId);

    const preV11 = Number(relay.version) < 11;
    if (preV11)
      throw new Error("This Pool is not supported for adding liquidity");

    const postV28 = Number(relay.version) >= 28;

    const matchedBalances = reserves
      .filter(reserve => reserve.amount)
      .map(reserve => {
        const relayReserve = findOrThrow(
          relay.reserves,
          relayReserve => compareString(relayReserve.contract, reserve.id),
          "failed to match passed reserves"
        );
        return {
          ...relayReserve,
          amount: reserve.amount
        };
      });

    const steps: Step[] = [
      {
        name: "CheckBalance",
        description: "Updating balance approvals..."
      },
      {
        name: "Funding",
        description: "Now funding..."
      },
      {
        name: "BlockConfirmation",
        description: "Awaiting block confirmation..."
      },
      {
        name: "Done",
        description: "Done!"
      }
    ];

    onUpdate!(0, steps);

    const converterAddress = relay.contract;

    await Promise.all(
      matchedBalances.map(async balance => {
        if (
          compareString(balance.contract, ethErc20WrapperContract) &&
          !postV28
        ) {
          await this.mintEthErc(balance.amount!);
        }
        if (compareString(balance.contract, ethReserveAddress)) return;
        return this.triggerApprovalIfRequired({
          owner: this.isAuthenticated,
          amount: expandToken(balance.amount!, balance.decimals),
          spender: converterAddress,
          tokenAddress: balance.contract
        });
      })
    );

    onUpdate!(1, steps);

    let txHash: string;

    if (postV28 && relay.converterType == PoolType.Traditional) {
      console.log("treating as a traditional relay");
      const { smartTokenAmount } = await this.calculateOpposingDepositInfo({
        id: relay.id,
        reserve: reserves[0]
      });
      const reducedWei = new BigNumber(smartTokenAmount.amount)
        .times(0.99)
        .toFixed(0);
      txHash = await this.addLiquidityV28({
        converterAddress,
        reserves: matchedBalances.map(balance => ({
          tokenContract: balance.contract,
          weiAmount: expandToken(balance.amount, balance.decimals)
        })),
        minimumReturnWei: reducedWei,
        onHash: () => onUpdate!(2, steps)
      });
    } else if (postV28 && relay.converterType == PoolType.ChainLink) {
      console.log("treating as a chainlink v2 relay");
      const chainLinkRelay = await this.chainLinkRelayById(relay.id);
      const reserveToken = matchedBalances.map(balance => ({
        tokenContract: balance.contract,
        weiAmount: expandToken(balance.amount, balance.decimals)
      }))[0];
      const poolToken = chainLinkRelay.anchor.poolTokens.find(poolToken =>
        compareString(poolToken.reserveId, reserveToken.tokenContract)
      );
      if (!poolToken)
        throw new Error("Client side error - failed finding pool token");
      if (poolToken.poolToken.decimals !== matchedBalances[0].decimals)
        throw new Error("Client side decimal rounding issue");
      const minimumReturnWei = new BigNumber(reserveToken.weiAmount)
        .times(0.98)
        .toString();
      console.log(minimumReturnWei, "is minimum return wei");
      txHash = await this.addLiquidityV2({
        converterAddress,
        reserve: reserveToken,
        poolTokenMinReturnWei: minimumReturnWei,
        onHash: () => onUpdate!(2, steps)
      });
    } else {
      console.log("treating as an old tradtional relay");
      const { smartTokenAmount } = await this.calculateOpposingDepositInfo({
        reserve: reserves[0],
        id: relayId
      });

      const fundAmount = smartTokenAmount;

      txHash = await this.fundRelay({
        converterAddress,
        fundAmount: fundAmount.amount,
        onHash: () => onUpdate!(2, steps)
      });
    }

    onUpdate!(3, steps);

    const anchorTokens = getAnchorTokenAddresses(relay);

    const tokenAddressesChanged = [
      ...matchedBalances.map(x => x.contract),
      ...anchorTokens
    ];
    this.spamBalances(tokenAddressesChanged);
    return txHash;
  }

  @action async spamBalances(tokenAddresses: string[]) {
    for (var i = 0; i < 5; i++) {
      tokenAddresses.forEach(tokenContractAddress =>
        this.getUserBalance({ tokenContractAddress })
      );
      await wait(1500);
    }
  }

  @action async fetchContractAddresses(contractRegistry: string) {
    const hardCodedBytes: RegisteredContracts = {
      BancorNetwork: asciiToHex("BancorNetwork"),
      BancorConverterRegistry: asciiToHex("BancorConverterRegistry")
    };

    const registryContract = new web3.eth.Contract(
      ABIContractRegistry,
      contractRegistry
    );

    const bytesKeys = Object.keys(hardCodedBytes);
    const bytesList = Object.values(hardCodedBytes);

    try {
      const contractAddresses = await Promise.race([
        Promise.all(
          bytesList.map(bytes =>
            registryContract.methods.addressOf(bytes).call()
          )
        ),
        wait(10000).then(() => {
          throw new Error(
            "Failed to resolve the Ethereum Bancor Contracts, BancorNetwork, BancorConverterRegistry, BancorX and BancorConverterFactory."
          );
        })
      ]);

      const zipped = zip(bytesKeys, contractAddresses) as [string, string][];

      const object = zipped.reduce(
        (acc, [key, value]) => ({
          ...acc,
          [key!]: value
        }),
        {}
      ) as RegisteredContracts;
      this.setContractAddresses(object);
      return object;
    } catch (e) {
      console.error(`Failed fetching ETH contract addresses ${e.message}`);
      throw new Error(e.message);
    }
  }

  @mutation setContractAddresses(contracts: RegisteredContracts) {
    this.contracts = contracts;
  }

  @action async warmEthApi() {
    const tokens = await ethBancorApi.getTokens();
    this.setBancorApiTokens(tokens);
    return tokens;
  }

  @action async buildPossibleReserveFeedsFromBancorApi(relays: Relay[]) {
    const feeds = await this.possibleRelayFeedsFromBancorApi(relays);
    const noFeedsCreated = feeds.length == 0;
    if (noFeedsCreated && this.currentNetwork == EthNetworks.Mainnet) {
      console.warn(
        `Failed to create any feeds from the Bancor API after passing it ${relays.length} relays.`
      );
    }
    this.updateRelayFeeds(feeds);
  }

  @action async possibleRelayFeedsFromBancorApi(
    relays: Relay[]
  ): Promise<ReserveFeed[]> {
    const traditionalRelays = relays.filter(
      isTraditional
    ) as TraditionalRelay[];
    try {
      const tokens = this.bancorApiTokens;
      if (!tokens || tokens.length == 0) {
        throw new Error("No bancor tokens available...");
      }
      const ethUsdPrice = findOrThrow(
        tokens,
        token => token.code == "ETH",
        "failed finding price of ETH from tokens request"
      ).price;
      console.log(ethUsdPrice, "is the eth USD price");

      return traditionalRelays
        .filter(relay => {
          const dictionaryItems = ethBancorApiDictionary.filter(catalog =>
            compareString(relay.anchor.contract, catalog.smartTokenAddress)
          );
          return tokens.some(token =>
            dictionaryItems.some(dic => compareString(dic.tokenId, token.id))
          );
        })
        .flatMap(relay =>
          relay.reserves.map(reserve => {
            const foundDictionaries = ethBancorApiDictionary.filter(catalog =>
              compareString(catalog.smartTokenAddress, relay.anchor.contract)
            );

            const bancorIdRelayDictionary =
              foundDictionaries.length == 1
                ? foundDictionaries[0]
                : foundDictionaries.find(dictionary =>
                    compareString(reserve.contract, dictionary.tokenAddress)
                  )!;
            const tokenPrice = tokens.find(token =>
              compareString(token.id, bancorIdRelayDictionary.tokenId)
            )!;

            const relayFeed = tokenPriceToFeed(
              reserve.contract,
              relay.anchor.contract,
              ethUsdPrice,
              tokenPrice
            );

            if (
              compareString(
                bancorIdRelayDictionary.tokenAddress,
                reserve.contract
              )
            ) {
              return relayFeed;
            } else {
              return {
                ...relayFeed,
                costByNetworkUsd: undefined,
                change24H: undefined,
                volume24H: undefined
              };
            }
          })
        );
    } catch (e) {
      console.warn(`Failed utilising Bancor API: ${e.message}`);
      return [];
    }
  }

  @mutation updateRelayFeeds(feeds: ReserveFeed[]) {
    const allFeeds = [...feeds, ...this.relayFeed];
    this.relayFeed = Object.freeze(allFeeds);
  }

  @action async fetchBancorUsdPriceOfBnt() {
    const tokens = await ethBancorApi.getTokens();
    const usdPriceOfBnt = findOrThrow(tokens, token => token.code == "BNT")
      .price;
    return usdPriceOfBnt;
  }

  @action async fetchUsdPriceOfBnt() {
    const price = await vxm.bancor.fetchUsdPriceOfBnt();
    this.setBntUsdPrice(price);
    return price;
  }

  @mutation setBntUsdPrice(usdPrice: number) {
    this.bntUsdPrice = usdPrice;
  }

  @action async fetchStakedReserveBalance({
    converterAddress,
    reserveTokenAddress
  }: {
    converterAddress: string;
    reserveTokenAddress: string;
  }): Promise<string> {
    const contract = buildV2Converter(converterAddress);
    return contract.methods.reserveStakedBalance(reserveTokenAddress).call();
  }

  @action async fetchV2ConverterReserveWeights(converterAddress: string) {
    const contract = buildV2Converter(converterAddress);
    const weights = await contract.methods.effectiveReserveWeights().call();
    return [weights["0"], weights["1"]];
  }

  @action async buildTraditionalReserveFeeds({
    relays,
    usdPriceOfBnt
  }: {
    relays: RelayWithReserveBalances[];
    usdPriceOfBnt: number;
  }) {
    return relays.flatMap(relay => {
      const reservesBalances = relay.reserves.map(reserve => {
        const reserveBalance = findOrThrow(
          relay.reserveBalances,
          balance => compareString(balance.id, reserve.contract),
          "failed to find a reserve balance for reserve"
        );
        const decNumber = shrinkToken(reserveBalance.amount, reserve.decimals);
        return [reserve, Number(decNumber)] as [Token, number];
      });

      const [
        [networkReserve, networkReserveAmount],
        [tokenReserve, tokenAmount]
      ] = sortByNetworkTokens(reservesBalances, balance =>
        balance[0].symbol.toUpperCase()
      );

      const networkReserveIsUsd = networkReserve.symbol == "USDB";
      const dec = networkReserveAmount / tokenAmount;
      const reverse = tokenAmount / networkReserveAmount;
      const main = networkReserveIsUsd ? dec : dec * usdPriceOfBnt;

      const liqDepth =
        (networkReserveIsUsd
          ? networkReserveAmount
          : networkReserveAmount * usdPriceOfBnt) * 2;
      return [
        {
          tokenId: tokenReserve.contract,
          poolId: relay.id,
          costByNetworkUsd: main,
          liqDepth
        },
        {
          tokenId: networkReserve.contract,
          poolId: relay.id,
          liqDepth,
          costByNetworkUsd: reverse * main
        }
      ];
    });
  }

  get loadingTokens() {
    return this.loadingPools;
  }

  get moreTokensAvailable() {
    return this.morePoolsAvailable;
  }

  @action async relaysContainingToken(tokenId: string): Promise<string[]> {
    return getConvertibleTokenAnchors({
      converterRegistryAddress: this.contracts.BancorConverterRegistry,
      tokenAddress: tokenId
    });
  }

  get convertibleTokens() {
    return this.convertibleTokenAddresses
      .map(
        convertibleToken =>
          this.tokenMeta.find(meta =>
            compareString(convertibleToken, meta.contract)
          )!
      )
      .filter(Boolean)
      .map(meta => ({ ...meta, img: meta.image }));
  }

  @action async loadMoreTokens(tokenIds?: string[]) {
    if (tokenIds && tokenIds.length > 0) {
      const anchorAddresses = await Promise.all(
        tokenIds.map(id => this.relaysContainingToken(id))
      );
      const anchorAddressesNotLoaded = anchorAddresses
        .flat(1)
        .filter(
          anchorAddress =>
            !this.relaysList.some(relay =>
              compareString(relay.id, anchorAddress)
            )
        );
      const convertersAndAnchors = await this.addConvertersToAnchors(
        anchorAddressesNotLoaded
      );
      await this.addPoolsV2(convertersAndAnchors);
    } else {
      await this.loadMorePools();
    }
  }

  @mutation setAvailableHistories(smartTokenNames: string[]) {
    this.availableHistories = smartTokenNames;
  }

  @action async refresh() {
    console.log("refresh called on eth bancor, doing nothing");
  }

  @action async fetchConvertibleTokens(networkContract: string) {
    const contract = await buildRegistryContract(networkContract);
    return contract.methods.getConvertibleTokens().call();
  }

  @mutation setRegisteredAnchorAddresses(addresses: string[]) {
    this.registeredAnchorAddresses = addresses;
  }

  @mutation setConvertibleTokenAddresses(addresses: string[]) {
    this.convertibleTokenAddresses = addresses;
  }

  @action async conversionPathFromNetworkContract({
    from,
    to,
    networkContractAddress
  }: {
    from: string;
    to: string;
    networkContractAddress: string;
  }) {
    return conversionPath({ networkContractAddress, from, to });
  }

  @action async relaysRequiredForTrade({
    from,
    to,
    networkContractAddress
  }: {
    from: string;
    to: string;
    networkContractAddress: string;
  }) {
    try {
      const path = await this.conversionPathFromNetworkContract({
        from,
        to,
        networkContractAddress
      });
      const smartTokenAddresses = path.filter((_, index) => isOdd(index));
      if (smartTokenAddresses.length == 0)
        throw new Error("Failed to find any smart token addresses for path.");
      return smartTokenAddresses;
    } catch (e) {
      console.error(`relays required for trade failed ${e.message}`);
      throw new Error(`relays required for trade failed ${e.message}`);
    }
  }

  @action async poolsByPriority({
    anchorAddressess,
    tokenPrices
  }: {
    anchorAddressess: string[];
    tokenPrices?: TokenPrice[];
  }) {
    if (tokenPrices && tokenPrices.length > 0) {
      return sortSmartTokenAddressesByHighestLiquidity(
        tokenPrices,
        anchorAddressess
      );
    } else {
      return sortAlongSide(anchorAddressess, x => x, priorityEthPools);
    }
  }

  @action async bareMinimumPools({
    params,
    networkContractAddress,
    anchorAddressess,
    tokenPrices
  }: {
    params?: ModuleParam;
    networkContractAddress: string;
    anchorAddressess: string[];
    tokenPrices?: TokenPrice[];
  }): Promise<string[]> {
    const fromToken =
      params! && params!.tradeQuery! && params!.tradeQuery!.base!;
    const toToken =
      params! && params!.tradeQuery! && params!.tradeQuery!.quote!;

    const tradeIncluded = fromToken && toToken;
    const poolIncluded = params && params.poolQuery;

    if (tradeIncluded) {
      console.log("trade included...");
      const res = await this.relaysRequiredForTrade({
        from: fromToken,
        to: toToken,
        networkContractAddress
      });
      console.log(res, `was for ${fromToken} and ${toToken}`);
      return res;
    } else if (poolIncluded) {
      console.log("pool included...");
      return [poolIncluded];
    } else {
      console.log("should be loading first 5");
      const allPools = await this.poolsByPriority({
        anchorAddressess,
        tokenPrices
      });
      return allPools.slice(0, 3);
    }
  }

  @action async fetchWithMultiCall({
    calls,
    strict = false
  }: {
    calls: MultiCall[];
    strict?: boolean;
  }): Promise<MultiCallReturn[]> {
    const networkVars = getNetworkVariables(this.currentNetwork as EthNetworks);
    const multiContract = buildMultiCallContract(networkVars.multiCall);
    console.count("MultiCall");
    console.log("Calls Amount", calls.length);

    const res = await multiContract.methods.aggregate(calls, strict).call();

    const matched = zip(
      calls.map(([address]) => address),
      res.returnData
    ) as MultiCallReturn[];
    return matched;
  }

  x = {
    calls: [] as MultiCall[],
    depth: 9999
  };

  @mutation recordDepthError({
    calls,
    depth
  }: {
    calls: MultiCall[];
    depth: number;
  }) {
    if (depth < this.x.depth) {
      console.log("recording depth change");
      this.x = { calls, depth };
    } else {
      console.log("ignoring depth change");
    }
  }

  // @ts-ignore
  @action async multiCallInChunks({
    chunkSizes,
    flatCalls
  }: {
    chunkSizes: number[];
    flatCalls: MultiCall[];
  }) {
    for (const chunkSize of chunkSizes) {
      const chunked: MultiCall[][] = chunk(flatCalls, chunkSize);
      try {
        // @ts-ignore
        const oneByOne = await Promise.all(
          chunked.map(async callGroup => {
            try {
              return await this.fetchWithMultiCall({ calls: callGroup });
            } catch (e) {
              this.recordDepthError({ calls: callGroup, depth: chunkSize });
              const currentIndex = chunkSizes.indexOf(chunkSize);
              if (currentIndex == 0) {
                console.error("Chunk attempt failed", callGroup);
                throw new Error("Ran out of chunks to try");
              }
              const smallerChunkSize = chunkSizes.slice(currentIndex);
              return await this.multiCallInChunks({
                flatCalls: callGroup,
                chunkSizes: smallerChunkSize
              });
            }
          })
        );

        return oneByOne.flat(1);
      } catch (e) {
        console.log("Failed, trying again with next chunk");
      }
    }
    throw new Error("Multi call in chunks failed");
  }

  @action async multiCallSmart(
    calls: MultiCall[][]
  ): Promise<MultiCallReturn[][]> {
    if (!calls || calls.length == 0) {
      return [];
    }

    const indexes = createIndexes(calls);
    const flattened = calls.flat(1);
    // try {
    //   console.log("making direct request amount of...", flattened.length);
    //   const rawRes = await this.fetchWithMultiCall({ calls: flattened });
    //   const reJoined = rebuildFromIndex(rawRes, indexes);
    //   console.count("FirstGO");
    //   return reJoined;
    // } catch (e) {
    const secondTry = await this.multiCallInChunks({
      chunkSizes: [5000, 150, 45, 15, 5],
      flatCalls: flattened
    });
    return rebuildFromIndex(secondTry, indexes);
    // }
  }

  @action async addPoolsV2(
    convertersAndAnchors: ConverterAndAnchor[]
  ): Promise<V2Response> {
    const allAnchors = convertersAndAnchors.map(item => item.anchorAddress);
    const allConverters = convertersAndAnchors.map(
      item => item.converterAddress
    );

    console.time("firstWaterfall");

    console.log("Started 1st section");
    const [firstHalfs, poolAndSmartTokens] = (await this.smartMulti([
      relayHandler(allConverters),
      miniPoolHandler(allAnchors)
    ])) as [AbiRelay[], AbiCentralPoolToken[]];

    console.log("Ended 1st section");
    console.log({ firstHalfs, poolAndSmartTokens });

    const { poolTokenAddresses, smartTokens } = seperateMiniTokens(
      poolAndSmartTokens
    );

    console.log({ poolTokenAddresses, smartTokens }, "are through");

    const polished: RefinedAbiRelay[] = firstHalfs.map(half => ({
      ...half,
      anchorAddress: findOrThrow(convertersAndAnchors, item =>
        compareString(item.converterAddress, half.converterAddress)
      ).anchorAddress,
      reserves: [half.connectorToken1, half.connectorToken2] as [
        string,
        string
      ],
      version: Number(half.version),
      converterType: determineConverterType(half.converterType)
    }));

    console.log({ polished });

    const overWroteVersions = updateArray(
      polished,
      relay =>
        knownVersions.some(r =>
          compareString(r.converterAddress, relay.converterAddress)
        ),
      relay => ({
        ...relay,
        version: knownVersions.find(r =>
          compareString(r.converterAddress, relay.converterAddress)
        )!.version
      })
    );

    console.log({ overWroteVersions });
    const passedFirstHalfs = overWroteVersions
      .filter(hasTwoConnectors)
      .filter(reservesInTokenMeta(this.tokenMeta))
      .filter(
        relay =>
          this.currentNetwork == EthNetworks.Ropsten ||
          networkTokenIncludedInReserves(networkTokenAddresses)(relay)
      );

    console.log({ passedFirstHalfs });

    const verifiedV1Pools = passedFirstHalfs.filter(
      half => half.converterType == PoolType.Traditional
    );

    const verifiedV2Pools = passedFirstHalfs.filter(
      half => half.converterType == PoolType.ChainLink
    );

    console.log({ verifiedV1Pools, verifiedV2Pools });

    const reserveTokens = uniqWith(
      passedFirstHalfs.flatMap(half => half.reserves),
      compareString
    );

    console.time("secondWaterfall");

    const tokenInMeta = (tokenMeta: TokenMeta[]) => (address: string) =>
      tokenMeta.find(
        meta => compareString(address, meta.contract) && meta.precision
      );

    const allTokensRequired = [
      ...reserveTokens,
      ...poolTokenAddresses.flatMap(pool => pool.poolTokenAddresses)
    ].filter(tokenAddress => !compareString(tokenAddress, ethReserveAddress));

    const tokenAddressesKnown = allTokensRequired.filter(
      tokenInMeta(this.tokenMeta)
    );
    console.log(tokenAddressesKnown.length, "saved on requests");
    const tokensKnown = tokenAddressesKnown.map(address => {
      const meta = tokenInMeta(this.tokenMeta)(address)!;
      return metaToTokenAssumedPrecision(meta);
    });
    const tokenAddressesMissing = differenceWith(
      allTokensRequired,
      tokenAddressesKnown,
      compareString
    );
    console.log("fetching", tokenAddressesMissing, "addresses missing");

    const [
      reserveAndPoolTokens,
      v1ReserveBalances,
      stakedAndReserveWeights
    ] = (await this.smartMulti([
      tokenHandler(tokenAddressesMissing),
      reserveBalanceHandler(verifiedV1Pools),
      stakedAndReserveHandler(
        verifiedV2Pools.map(pool => ({
          converterAdress: pool.converterAddress,
          reserveOne: pool.connectorToken1,
          reserveTwo: pool.connectorToken2
        }))
      )
    ])) as [Token[], DecodedResult<RawAbiReserveBalance>[], StakedAndReserve[]];

    const allTokens = [...reserveAndPoolTokens, ...tokensKnown];

    const polishedReserveAndPoolTokens = polishTokens(
      this.tokenMeta,
      allTokens
    );

    console.log({
      reserveAndPoolTokens,
      polishedReserveAndPoolTokens,
      v1ReserveBalances,
      stakedAndReserveWeights
    });

    const matched = stakedAndReserveWeights.map(relay => ({
      ...relay,
      anchorAddress: findOrThrow(convertersAndAnchors, item =>
        compareString(item.converterAddress, relay.converterAddress)
      ).anchorAddress,
      reserves: relay.reserves.map(reserve => ({
        ...reserve,
        token: polishedReserveAndPoolTokens.find(token =>
          compareString(token.contract, reserve.reserveAddress)
        )
      }))
    }));

    const confirmedTokenMatch = matched.filter(match =>
      match.reserves.every(reserve => reserve.token)
    ) as RawV2Pool[];

    const v2RelayFeeds = buildRelayFeedChainkLink({
      relays: confirmedTokenMatch,
      usdPriceOfBnt: this.bntUsdPrice
    });

    console.timeEnd("secondWaterfall");

    const v2Pools = verifiedV2Pools.map(
      (pool): ChainLinkRelay => {
        const rawPool = findOrThrow(confirmedTokenMatch, match =>
          compareString(match.converterAddress, pool.converterAddress)
        );

        return {
          anchor: {
            poolContainerAddress: rawPool.anchorAddress,
            poolTokens: rawPool.reserves.map(reserve => ({
              reserveId: reserve.reserveAddress,
              poolToken: findOrThrow(
                polishedReserveAndPoolTokens,
                token =>
                  compareString(token.contract, reserve.poolTokenAddress),
                `failed to find the pool token for ${reserve.poolTokenAddress}`
              )
            }))
          },
          contract: pool.converterAddress,
          id: rawPool.anchorAddress,
          converterType: PoolType.ChainLink,
          isMultiContract: false,
          network: "ETH",
          owner: pool.owner,
          reserves: rawPool.reserves.map(reserve => ({
            ...reserve.token,
            reserveWeight: Number(reserve.reserveWeight) / oneMillion.toNumber()
          })),
          version: String(pool.version),
          fee: Number(pool.conversionFee) / 10000
        };
      }
    );

    const v1Pools = verifiedV1Pools.map(pool => {
      const smartTokenAddress = pool.anchorAddress;
      const converterAddress = convertersAndAnchors.find(item =>
        compareString(item.anchorAddress, smartTokenAddress)
      )!.converterAddress;
      const polishedHalf = overWroteVersions.find(pol =>
        compareString(pol.converterAddress, converterAddress)
      )!;
      const smartToken = smartTokens.find(token =>
        compareString(token.contract, smartTokenAddress)
      )!;
      const anchorProps = smartTokenAnchor({
        ...smartToken,
        network: "ETH",
        decimals: Number(smartToken.decimals)
      });
      const reserveBalances = v1ReserveBalances.find(reserve =>
        compareString(reserve.originAddress, converterAddress)
      )!;
      if (!reserveBalances) {
        console.count("DropDueToNoReserveBalances");
        return;
      }
      const zippedReserveBalances = [
        {
          contract: polishedHalf.connectorToken1,
          amount: reserveBalances.data.reserveOne
        },
        {
          contract: polishedHalf.connectorToken2,
          amount: reserveBalances.data.reserveTwo
        }
      ];
      const reserveTokens = zippedReserveBalances.map(
        reserve =>
          polishedReserveAndPoolTokens.find(token =>
            compareString(token.contract, reserve.contract)
          )!
      );

      const relay: RelayWithReserveBalances = {
        id: smartTokenAddress,
        reserves: reserveTokens.map(x => ({ ...x, reserveWeight: 0.5 })),
        reserveBalances: zippedReserveBalances.map(zip => ({
          amount: zip.amount,
          id: zip.contract
        })),
        contract: converterAddress,
        fee: Number(polishedHalf.conversionFee) / 10000,
        isMultiContract: false,
        network: "ETH",
        owner: polishedHalf.owner,
        version: String(polishedHalf.version),
        anchor: anchorProps.anchor,
        converterType: anchorProps.converterType
      };

      return relay;
    });

    const completeV1Pools = (v1Pools.filter(
      Boolean
    ) as RelayWithReserveBalances[]).filter(x => x.reserves.every(Boolean));

    console.log({ v1Pools, v2Pools });
    const traditionalRelayFeeds = await this.buildTraditionalReserveFeeds({
      relays: completeV1Pools,
      usdPriceOfBnt: this.bntUsdPrice
    });

    const reserveFeeds = [...traditionalRelayFeeds, ...v2RelayFeeds];
    const pools = [...v2Pools, ...completeV1Pools];

    // debug
    const failed = differenceWith(convertersAndAnchors, pools, (a, b) =>
      compareString(a.converterAddress, b.contract)
    );
    if (failed.length > 0) {
      console.warn(failed, "FAILS");
    }

    // end debug

    return {
      reserveFeeds,
      pools
    };
  }

  @mutation deletePools(ids: string[]) {
    this.relaysList = this.relaysList.filter(
      relay => !ids.some(id => compareString(relay.id, id))
    );
  }

  @action async reloadPools(anchorAndConverters: ConverterAndAnchor[]) {
    this.deletePools(anchorAndConverters.map(x => x.anchorAddress));
    this.addPoolsBulk(anchorAndConverters);
  }

  @action async add(anchorAddresses: string[]) {
    const converters = await this.fetchConverterAddressesByAnchorAddresses(
      anchorAddresses
    );
    return zipAnchorAndConverters(anchorAddresses, converters);
  }

  @action async replayIfDifference(convertersAndAnchors: ConverterAndAnchor[]) {
    const anchorAddresses = convertersAndAnchors.map(x => x.anchorAddress);
    const latest = await this.add(anchorAddresses);
    const exactSame = latest.every(newAnchorPair =>
      convertersAndAnchors.some(oldAnchorPair =>
        compareAnchorAndConverter(newAnchorPair, oldAnchorPair)
      )
    );

    if (!exactSame) {
      const difference = differenceWith(
        latest,
        convertersAndAnchors,
        compareAnchorAndConverter
      );
      this.reloadPools(difference);
    } else {
      console.log("exact same! was okay in caching");
    }

    try {
      const db = await openDB<MyDB>("bancor", 4);
      const tx = db.transaction("anchorPair", "readwrite");
      const store = await tx.objectStore("anchorPair");
      await Promise.all(
        latest.map(pair => store.put(pair, pair.anchorAddress))
      );
      await tx.done;
    } catch (e) {
      console.error(e);
    }
  }

  @action async addConvertersToAnchors(
    anchorAddresses: string[]
  ): Promise<ConverterAndAnchor[]> {
    console.time("fetchConverterAddressesByAnchorAddresses");

    const db = await openDB<MyDB>("bancor", 4);

    const items = await db
      .transaction("anchorPair")
      .objectStore("anchorPair")
      .getAll();
    console.log(items, "were items!");

    const allAnchorsFulfilled = anchorAddresses.every(anchor =>
      items.some(x => compareString(anchor, x.anchorAddress))
    );
    if (allAnchorsFulfilled) {
      this.replayIfDifference(items);
      console.timeEnd("fetchConverterAddressesByAnchorAddresses");

      return items;
    } else {
      const converters = await this.fetchConverterAddressesByAnchorAddresses(
        anchorAddresses
      );
      const latest = zipAnchorAndConverters(anchorAddresses, converters);
      this.replayIfDifference(latest);
      console.timeEnd("fetchConverterAddressesByAnchorAddresses");
      return latest;
    }
  }

  @action async smartMulti(handlers: Handler[]) {
    const allCallGroups = handlers.map(callSection => callSection.callGroups);
    const indexes = createIndexes(allCallGroups);
    const flattened = allCallGroups.flat(1);
    const allCalls = await this.multiCallSmart(flattened);

    const rebuilt = rebuildFromIndex(allCalls, indexes);

    const res = handlers.map((handler, index) =>
      rebuilt[index].flatMap(handler.finisher)
    );

    return res;
  }

  @action async init(params?: ModuleParam) {
    console.log(params, "was init param on eth");
    console.time("ethResolved");
    console.time("timeToGetToInitialBulk");
    if (this.initiated) {
      console.log("returning already");
      return this.refresh();
    }

    BigNumber.config({ EXPONENTIAL_AT: 256 });

    // const bigBnt = new BigNumber(toWei("100000"));
    // const bntBalance = new BigNumber("3917675891686726629443620");
    // const percent = bigBnt.div(bntBalance).toString();
    // console.log(percent, "is the percent");

    const web3NetworkVersion = await web3.eth.getChainId();
    const currentNetwork: EthNetworks = web3NetworkVersion;
    console.log(currentNetwork, "is the current network");
    this.setNetwork(currentNetwork);
    const networkVariables = getNetworkVariables(currentNetwork);

    const testnetActive = currentNetwork == EthNetworks.Ropsten;

    if (
      params &&
      params.tradeQuery &&
      params.tradeQuery.quote &&
      testnetActive
    ) {
      params.tradeQuery.quote = networkVariables.bntToken;
    }

    try {
      let bancorApiTokens: TokenPrice[] = [];

      this.warmEthApi()
        .then(tokens => {
          bancorApiTokens = tokens;
        })
        .catch(e => [] as TokenPrice[]);

      getTokenMeta(currentNetwork).then(meta => {
        this.setTokenMeta(meta);
      });
      this.fetchUsdPriceOfBnt();

      fetchSmartTokens()
        .then(availableSmartTokenHistories =>
          this.setAvailableHistories(
            availableSmartTokenHistories.map(history => history.id)
          )
        )
        .catch(_ => {});
      console.time("FirstPromise");
      let [contractAddresses] = await Promise.all([
        this.fetchContractAddresses(networkVariables.contractRegistry)
      ]);
      console.timeEnd("FirstPromise");

      console.time("SecondPromise");
      const [registeredAnchorAddresses, convertibleTokens] = await Promise.all([
        this.fetchAnchorAddresses(contractAddresses.BancorConverterRegistry),
        this.fetchConvertibleTokens(contractAddresses.BancorConverterRegistry)
      ]);
      console.timeEnd("SecondPromise");

      console.log({ registeredAnchorAddresses, convertibleTokens });

      this.setRegisteredAnchorAddresses(registeredAnchorAddresses);
      this.setConvertibleTokenAddresses(convertibleTokens);

      console.time("ThirdPromise");
      const [
        anchorAndConvertersMatched,
        bareMinimumAnchorAddresses
      ] = await Promise.all([
        this.add(registeredAnchorAddresses),
        this.bareMinimumPools({
          params,
          networkContractAddress: contractAddresses.BancorNetwork,
          anchorAddressess: registeredAnchorAddresses,
          ...(bancorApiTokens &&
            bancorApiTokens.length > 0 && { tokenPrices: bancorApiTokens })
        })
      ]);
      console.timeEnd("ThirdPromise");

      const blackListedAnchors = ["0x7Ef1fEDb73BD089eC1010bABA26Ca162DFa08144"];

      const notBlackListed = (blackListedAnchors: string[]) => (
        converterAnchor: ConverterAndAnchor
      ) =>
        !blackListedAnchors.some(black =>
          compareString(black, converterAnchor.anchorAddress)
        );
      const passedAnchorAndConvertersMatched = anchorAndConvertersMatched.filter(
        notBlackListed(blackListedAnchors)
      );

      console.log({
        anchorAndConvertersMatched: passedAnchorAndConvertersMatched,
        bareMinimumAnchorAddresses
      });

      const requiredAnchors = bareMinimumAnchorAddresses.map(anchor =>
        findOrThrow(passedAnchorAndConvertersMatched, item =>
          compareString(item.anchorAddress, anchor)
        )
      );

      const priorityAnchors = await this.poolsByPriority({
        anchorAddressess: passedAnchorAndConvertersMatched.map(
          x => x.anchorAddress
        ),
        tokenPrices: bancorApiTokens
      });

      console.log({ priorityAnchors });

      const initialLoad = uniqWith(
        [...requiredAnchors],
        compareAnchorAndConverter
      );

      const remainingLoad = sortAlongSide(
        differenceWith(
          passedAnchorAndConvertersMatched,
          initialLoad,
          compareAnchorAndConverter
        ),
        anchor => anchor.anchorAddress,
        priorityAnchors
      );

      console.log("trying...");
      console.timeEnd("timeToGetToInitialBulk");
      console.time("initialPools");
      const x = await this.addPoolsBulk(initialLoad);
      console.timeEnd("initialPools");
      console.log("finished add pools...", x);

      try {
        await this.addPoolsBulk([
          {
            anchorAddress: "0xC42a9e06cEBF12AE96b11f8BAE9aCC3d6b016237",
            converterAddress: "0x222b06E3392998911A79C51Ee64b4aabE1653537"
          }
        ]);
      } catch (e) {
        console.log(e, "was e");
      }

      if (remainingLoad.length > 0) {
        const banned = [
          "0xfb64059D18BbfDc5EEdCc6e65C9F09de8ccAf5b6",
          "0xB485A5F793B1DEadA32783F99Fdccce9f28aB9a2",
          "0x444Bd9a308Bd2137208ABBcc3efF679A90d7A553",
          "0x5C8c7Ef16DaC7596C280E70C6905432F7470965E",
          "0x40c7998B5d94e00Cd675eDB3eFf4888404f6385F",
          "0x0429e43f488D2D24BB608EFbb0Ee3e646D61dE71",
          "0x7FF01DB7ae23b97B15Bc06f49C45d6e3d84df46f",
          "0x16ff969cC3A4AE925D9C0A2851e2386d61E75954",
          "0x72eC2FF62Eda1D5E9AcD6c4f6a016F0998ba1cB0",
          "0xcAf6Eb14c3A20B157439904a88F00a8bE929c887"
        ];
        const newSet = remainingLoad.filter(
          anchorAndConverter =>
            ![
              anchorAndConverter.converterAddress,
              anchorAndConverter.anchorAddress
            ].some(address => banned.some(x => x == address))
        );

        console.log({ newSet });
        this.addPoolsBulk(newSet);
      }
      this.moduleInitiated();

      if (this.relaysList.length < 1 || this.relayFeed.length < 2) {
        console.error("Init resolved with less than 2 relay feeds or 1 relay.");
      }
      console.timeEnd("ethResolved");
    } catch (e) {
      console.error(`Threw inside ethBancor ${e.message}`);
      throw new Error(`Threw inside ethBancor ${e.message}`);
    }
  }

  @action async addPoolsV1(convertersAndAnchors: ConverterAndAnchor[]) {
    // do it the way it happened before, adding dynamically and not waiting for the bulk to finish
  }

  @action async addPools(convertersAndAnchors: ConverterAndAnchor[]) {
    this.setLoadingPools(true);
    await this.addPoolsV1(convertersAndAnchors);
    this.setLoadingPools(false);
  }

  @action async addPoolsBulk(convertersAndAnchors: ConverterAndAnchor[]) {
    if (!convertersAndAnchors || convertersAndAnchors.length == 0)
      throw new Error("Received nothing for addPoolsBulk");

    this.setLoadingPools(true);

    const chunked = chunk(convertersAndAnchors, 30);
    const tokenAddresses: string[][] = [];

    const res = await Promise.all(chunked.map(this.addPoolsV2));
    const pools = flatMap(res, "pools");
    const reserveFeeds = flatMap(res, "reserveFeeds");
    // for (const chunk of chunked) {
    const poolsFailed = differenceWith(convertersAndAnchors, pools, (a, b) =>
      compareString(a.anchorAddress, b.id)
    );
    this.updateFailedPools(
      poolsFailed.map(failedPool => failedPool.anchorAddress)
    );
    this.updateRelays(pools);
    this.buildPossibleReserveFeedsFromBancorApi(pools);
    this.updateRelayFeeds(reserveFeeds);
    const tokensInChunk = pools
      .flatMap(tokensInRelay)
      .map(token => token.contract);
    tokenAddresses.push(tokensInChunk);
    // }
    if (this.isAuthenticated) {
      const toFetch = uniqWith(tokenAddresses.flat(), compareString);
      this.fetchBulkTokenBalances(toFetch);
    }
    this.setLoadingPools(false);

    console.timeEnd("addPoolsBulk");
  }

  @action async fetchBulkTokenBalances(tokenContractAddresses: string[]) {
    tokenContractAddresses.forEach(address =>
      this.getUserBalance({ tokenContractAddress: address })
    );
  }

  @action async addPoolsContainingTokenAddresses(tokenAddresses: string[]) {
    const anchorAddresses = await Promise.all(
      tokenAddresses.map(this.relaysContainingToken)
    );
    const uniqueAnchors = uniqWith(anchorAddresses.flat(1), compareString);
    const anchorsAndConverters = await this.addConvertersToAnchors(
      uniqueAnchors
    );
    this.addPoolsV2(anchorsAndConverters);
  }

  @action async fetchConverterAddressesByAnchorAddresses(
    anchorAddresses: string[]
  ) {
    return getConvertersByAnchors({
      anchorAddresses,
      converterRegistryAddress: this.contracts.BancorConverterRegistry
    });
  }

  @action async fetchAnchorAddresses(converterRegistryAddress: string) {
    return getAnchors(converterRegistryAddress);
  }

  @mutation updateRelays(relays: Relay[]) {
    const allReserves = this.relaysList
      .concat(relays)
      .flatMap(relay => relay.reserves);
    const uniqueTokens = uniqWith(allReserves, (a, b) =>
      compareString(a.contract, b.contract)
    );

    const decimalUniformityBetweenTokens = uniqueTokens.every(token => {
      const allReservesTokenFoundIn = allReserves.filter(reserve =>
        compareString(token.contract, reserve.contract)
      );
      return allReservesTokenFoundIn.every(
        (reserve, _, arr) => reserve.decimals == arr[0].decimals
      );
    });
    if (!decimalUniformityBetweenTokens) {
      console.error(
        `There is a mismatch of decimals between relays of the same token, will not store ${relays.length} new relays`
      );
      return;
    }

    const meshedRelays = uniqWith(
      [...relays, ...this.relaysList],
      compareRelayById
    );
    console.log(
      "vuex given",
      relays.length,
      "relays and setting",
      meshedRelays.length
    );
    this.relaysList = Object.freeze(meshedRelays);
  }

  @action async fetchReserveBalance({
    relay,
    reserveContract
  }: {
    relay: Relay;
    reserveContract: string;
  }): Promise<[Token, number]> {
    const reserveInRelay = findOrThrow(
      relay.reserves,
      reserve => compareString(reserve.contract, reserveContract),
      "Reserve is not in this relay!"
    );
    const converterContract = buildConverterContract(relay.contract);

    const reserveBalance = await fetchReserveBalance(
      converterContract,
      reserveContract,
      relay.version
    );
    const numberReserveBalance = shrinkToken(
      reserveBalance,
      reserveInRelay.decimals
    );
    return [reserveInRelay, Number(numberReserveBalance)];
  }

  @mutation wipeTokenBalances() {
    this.tokenBalances = [];
  }

  @action async onAuthChange(userAddress: string) {
    this.wipeTokenBalances();
    const allTokens = this.relaysList.flatMap(tokensInRelay);
    const uniqueTokenAddresses = uniqWith(
      allTokens.map(token => token.contract),
      compareString
    );
    uniqueTokenAddresses.forEach(tokenContractAddress =>
      this.getUserBalance({
        tokenContractAddress,
        userAddress
      })
    );
  }

  @action async focusSymbol(id: string) {
    if (!this.isAuthenticated) return;
    const tokenContractAddress = findOrThrow(
      this.tokenMeta,
      meta => compareString(meta.id, id),
      `failed to find this token contract address in meta (${id})`
    ).contract;
    const balance = await vxm.ethWallet.getBalance({
      accountHolder: this.isAuthenticated,
      tokenContractAddress
    });
    this.updateBalance([id!, Number(balance)]);

    const tokenTracked = this.tokens.find(token => compareString(token.id, id));
    if (!tokenTracked) {
      this.loadMoreTokens([id]);
    }
  }

  @mutation updateBalance([id, balance]: [string, number]) {
    const newBalances = this.tokenBalances.filter(
      balance => !compareString(balance.id, id)
    );
    newBalances.push({ id, balance });
    this.tokenBalances = newBalances;
  }

  @action async refreshBalances(symbols?: BaseToken[]) {
    if (symbols) {
      symbols.forEach(symbol => this.focusSymbol(symbol.symbol));
    }
  }

  @action async mintEthErcIfRequired(decString: string) {
    const contract = buildTokenContract(ethErc20WrapperContract);
    const currentBalance = await contract.methods
      .balanceOf(this.isAuthenticated)
      .call();

    const currentBalanceDec = Number(shrinkToken(currentBalance, 18));
    const numberBalance = Number(decString);

    const mintingRequired = numberBalance > currentBalanceDec;
    if (mintingRequired) {
      return this.mintEthErc(decString);
    }
  }

  @action async tokenById(id: string) {
    return findOrThrow(
      this.tokens,
      token => compareString(token.id, id),
      `tokenById failed to find token with ID ${id} `
    );
  }

  @action async tokensById(ids: string[]) {
    return Promise.all(ids.map(id => this.tokenById(id)));
  }

  @action async findPath({
    fromId,
    toId,
    relays
  }: {
    fromId: string;
    toId: string;
    relays: readonly Relay[];
  }) {
    const lowerCased = relays.map(relay => ({
      ...relay,
      reserves: relay.reserves.map(reserve => ({
        ...reserve,
        contract: reserve.contract.toLowerCase()
      }))
    }));
    const path = await findNewPath(
      fromId.toLowerCase(),
      toId.toLowerCase(),
      lowerCased,
      relay => [relay.reserves[0].contract, relay.reserves[1].contract]
    );

    const flattened = path.hops.flatMap(hop => hop[0]);
    return flattened.map(flat =>
      findOrThrow(
        relays,
        relay => compareString(relay.contract, flat.contract),
        "failed to find relays used in pathing"
      )
    );
  }

  @action async convert({ from, to, onUpdate }: ProposedConvertTransaction) {
    if (compareString(from.id, to.id))
      throw new Error("Cannot convert a token to itself.");
    const [fromToken, toToken] = await this.tokensById([from.id, to.id]);
    const fromIsEth = compareString(fromToken.symbol, "eth");

    const steps: Section[] = [
      {
        name: "Pathing",
        description: "Finding path..."
      },
      {
        name: "SetApprovalAmount",
        description: "Setting approval amount..."
      },
      {
        name: "ConvertProcessing",
        description: "Processing conversion..."
      },
      {
        name: "WaitingTxConf",
        description: "Awaiting block confirmation..."
      },
      {
        name: "Done",
        description: "Done!"
      }
    ];

    onUpdate!(0, steps);

    const fromTokenDecimals = await this.getDecimalsByTokenAddress(
      fromToken.id
    );
    const toTokenDecimals = await this.getDecimalsByTokenAddress(toToken.id);

    const relays = await this.findPath({
      relays: this.relaysList,
      fromId: from.id,
      toId: to.id
    });

    const fromAmount = from.amount;
    const toAmount = Number(to.amount);
    const fromSymbol = fromToken.symbol;
    const fromTokenContract = fromToken.id;
    const toTokenContract = toToken.id;

    const ethPath = generateEthPath(fromSymbol, relays.map(relayToMinimal));

    const fromWei = expandToken(fromAmount, fromTokenDecimals);

    if (!fromIsEth) {
      onUpdate!(1, steps);
      await this.triggerApprovalIfRequired({
        owner: this.isAuthenticated,
        amount: fromWei,
        spender: this.contracts.BancorNetwork,
        tokenAddress: fromTokenContract
      });
    }

    onUpdate!(2, steps);

    const networkContract = buildNetworkContract(this.contracts.BancorNetwork);

    const confirmedHash = await this.resolveTxOnConfirmation({
      tx: networkContract.methods.convertByPath(
        ethPath,
        fromWei,
        expandToken(toAmount * 0.99, toTokenDecimals),
        zeroAddress,
        zeroAddress,
        0
      ),
      ...(fromIsEth && { value: fromWei }),
      // gas: 550000 * 1.3,
      onHash: () => onUpdate!(3, steps)
    });
    onUpdate!(4, steps);
    wait(2000).then(() =>
      [fromTokenContract, toTokenContract].forEach(contract =>
        this.getUserBalance({ tokenContractAddress: contract })
      )
    );
    return confirmedHash;
  }

  @action async triggerApprovalIfRequired({
    owner,
    spender,
    amount,
    tokenAddress
  }: {
    owner: string;
    spender: string;
    tokenAddress: string;
    amount: string;
  }) {
    const currentApprovedBalance = await getApprovedBalanceWei({
      owner,
      spender,
      tokenAddress
    });

    if (Number(currentApprovedBalance) >= Number(amount)) return;

    const nullingTxRequired = fromWei(currentApprovedBalance) !== "0";
    if (nullingTxRequired) {
      await this.approveTokenWithdrawals([
        { approvedAddress: spender, amount: toWei("0"), tokenAddress }
      ]);
    }

    return this.approveTokenWithdrawals([
      { approvedAddress: spender, amount, tokenAddress }
    ]);
  }

  @action async getReturnByPath({
    path,
    amount
  }: {
    path: string[];
    amount: string;
  }): Promise<string> {
    return getReturnByPath({
      networkContract: this.contracts.BancorNetwork,
      path,
      amount
    });
  }

  @action async getDecimalsByTokenAddress(tokenAddress: string) {
    if (compareString(tokenAddress, ethReserveAddress)) return 18;
    const reserve = this.relaysList
      .flatMap(relay => relay.reserves)
      .find(reserve => compareString(reserve.contract, tokenAddress));
    if (!reserve) {
      try {
        const contract = buildTokenContract(tokenAddress);
        const decimals = await contract.methods.decimals().call();
        return Number(decimals);
      } catch (e) {
        throw new Error(
          `Failed to find token address ${tokenAddress} in list of reserves. ${e.message}`
        );
      }
    }
    return reserve.decimals;
  }

  @action async getReturn({
    from,
    toId
  }: ProposedFromTransaction): Promise<ConvertReturn> {
    if (compareString(from.id, toId))
      throw new Error("Cannot convert a token to itself.");
    const [fromToken, toToken] = await this.tokensById([from.id, toId]);

    const [fromTokenContract, toTokenContract] = [fromToken.id, toToken.id];
    const amount = from.amount;

    const fromTokenDecimals = await this.getDecimalsByTokenAddress(
      fromTokenContract
    );
    const toTokenDecimals = await this.getDecimalsByTokenAddress(
      toTokenContract
    );

    const relays = await this.findPath({
      fromId: from.id,
      toId,
      relays: this.relaysList
    });

    const path = generateEthPath(fromToken.symbol, relays.map(relayToMinimal));

    console.log(path, "is the path");

    const fromWei = expandToken(amount, fromTokenDecimals);
    const wei = await this.getReturnByPath({
      path,
      amount: fromWei
    });
    const weiNumber = new BigNumber(wei);

    const userReturnRate = buildRate(new BigNumber(fromWei), weiNumber);

    let slippage: number | undefined;
    try {
      const contract = buildConverterContract(relays[0].contract);
      const fromReserveBalanceWei = await contract.methods
        .getConnectorBalance(fromTokenContract)
        .call();

      const smallPortionOfReserveBalance = new BigNumber(
        fromReserveBalanceWei
      ).times(0.00001);

      if (smallPortionOfReserveBalance.isLessThan(fromWei)) {
        const smallPortionOfReserveBalanceWei = smallPortionOfReserveBalance.toFixed(
          0
        );

        const smallPortionReturn = await this.getReturnByPath({
          path,
          amount: smallPortionOfReserveBalanceWei
        });

        const tinyReturnRate = buildRate(
          new BigNumber(smallPortionOfReserveBalanceWei),
          new BigNumber(smallPortionReturn)
        );

        // const x = await this.testWeiReturns({
        //   path,
        //   amounts: [
        //     {
        //       label: "smallReturn",
        //       weiAmount: smallPortionOfReserveBalanceWei
        //     },
        //     { label: "userReturn", weiAmount: fromWei }
        //   ]
        // });
        const slippageNumber = calculateSlippage(
          tinyReturnRate,
          userReturnRate
        );
        slippage = slippageNumber.toNumber();
      }
    } catch (e) {
      console.warn("Failed calculating slippage", e.message);
    }

    return {
      amount: shrinkToken(wei, toTokenDecimals),
      slippage
    };
  }

  @action async getCost({ fromId, to }: ProposedToTransaction) {
    if (compareString(fromId, to.id))
      throw new Error("Cannot convert a token to itself.");
    const fromToken = await this.tokenById(fromId);
    const toToken = await this.tokenById(to.id);

    const amount = to.amount;

    const [fromTokenContract, toTokenContract] = [fromToken.id, toToken.id];

    const fromTokenDecimals = await this.getDecimalsByTokenAddress(
      fromTokenContract
    );
    const toTokenDecimals = await this.getDecimalsByTokenAddress(
      toTokenContract
    );

    const relays = this.relaysList;

    const poolIds = relays.map(relay => relay.id);
    const allCoveredUnderBancorApi = poolIds.every(poolId =>
      ethBancorApiDictionary.some(dic =>
        compareString(poolId, dic.smartTokenAddress)
      )
    );
    if (!allCoveredUnderBancorApi)
      throw new Error("Fetching the cost of this token is not yet supported.");

    const [fromTokenTicker, toTokenTicker] = await Promise.all([
      ethBancorApi.getToken(fromToken.symbol),
      ethBancorApi.getToken(toToken.symbol)
    ]);
    const fromTokenId = fromTokenTicker._id;
    const toTokenId = toTokenTicker._id;

    const result = await ethBancorApi.calculateCost(
      fromTokenId,
      toTokenId,
      expandToken(amount, toTokenDecimals)
    );

    return {
      amount: shrinkToken(result, fromTokenDecimals)
    };
  }
}
