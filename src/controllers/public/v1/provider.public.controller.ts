import { Request, Response, NextFunction } from 'express';
import { consumerError } from '../../../utils/consumerError';
import { restfulResponse } from '../../../libs/api/RESTfulResponse';
import { getContractUri } from '../../../libs/loaders/configuration';
import { getRepresentation } from '../../../libs/loaders/representationFetcher';
import { handle } from '../../../libs/loaders/handler';
import { getContract } from '../../../libs/services/contract';
import { getCatalogData } from '../../../libs/services/catalog';
import { consumerImport } from '../../../libs/services/consumer';
import { Logger } from '../../../libs/loggers';
import { pepVerification } from '../../../utils/pepVerification';
import { processLeftOperands } from '../../../utils/leftOperandProcessor';

/**
 * provider export data from data representation
 * @param req
 * @param res
 * @param next
 */
export const providerExport = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    const { dataExchange, consumerEndpoint, contract } = req.body;

    if (!(await getContractUri())) {
        await consumerError(
            consumerEndpoint,
            dataExchange._id,
            'Provider configuration error'
        );
    }

    const [contractResp, contractRespError] = await handle(
        getContract(contract)
    );

    if (contractRespError) {
        Logger.error({
            message: contractRespError,
            location: 'providerExport - contractRespError',
        });
        return restfulResponse(res, 400, { success: false });
    }

    const httpPattern = /^https?:\/\//;

    let serviceOffering: string;

    if (contract.includes('bilaterals')) {
        if (httpPattern.test(contractResp.serviceOffering)) {
            // Split the string by backslash and get the last element
            const pathElements = contractResp.serviceOffering.split('/');
            serviceOffering = pathElements[pathElements.length - 1];
        } else {
            serviceOffering = contractResp.serviceOffering;
        }
        // eslint-disable-next-line no-dupe-else-if
    } else if (contract.includes('contracts')) {
        serviceOffering = dataExchange.resourceId;
    }

    //PEP
    const { pep, contractID, resourceID } = await pepVerification({
        targetResource: serviceOffering,
        referenceURL: contract,
    });

    if (pep) {
        const [serviceOfferingSD, serviceOfferingSDError] = await handle(
            getCatalogData(
                contractResp?.serviceOffering ?? dataExchange.resourceId
            )
        );

        if (serviceOfferingSDError) {
            Logger.error({
                message: serviceOfferingSDError,
                location: 'providerExport - serviceOfferingSDError',
            });
            return restfulResponse(res, 400, { success: false });
        }

        const resourceSD = serviceOfferingSD.dataResources[0];

        // B to B exchange
        if (dataExchange._id && consumerEndpoint && resourceSD) {
            //Call the catalog endpoint
            const [endpointData, endpointDataError] = await handle(
                getCatalogData(resourceSD)
            );

            if (endpointDataError) {
                Logger.error({
                    message: endpointDataError,
                    location: 'providerExport - endpointDataError',
                });
                return restfulResponse(res, 400, { success: false });
            }

            if (!endpointData?.representation) {
                await consumerError(
                    consumerEndpoint,
                    dataExchange._id,
                    'No representation found'
                );
            }

            let data;
            switch (endpointData?.representation?.type) {
                case 'REST':
                    // eslint-disable-next-line no-case-declarations
                    const [getProviderData, getProviderDataError] =
                        await handle(
                            getRepresentation(
                                endpointData?.representation?.method,
                                endpointData?.representation?.url,
                                endpointData?.representation?.credential
                            )
                        );

                    if (getProviderDataError) {
                        Logger.error({
                            message: getProviderDataError,
                            location: 'providerExport - getRepresentation',
                        });
                        return restfulResponse(res, 400, { success: false });
                    }

                    data = getProviderData;
                    break;
            }

            if (!data) {
                await consumerError(
                    consumerEndpoint,
                    dataExchange._id,
                    'No Data found'
                );
            }

            //Send the data to generic endpoint
            const [consumerImportRes, consumerImportResError] = await handle(
                consumerImport(consumerEndpoint, dataExchange._id, data)
            );

            if (consumerImportResError) {
                Logger.error({
                    message: consumerImportResError,
                    location: 'providerExport - consumerImport',
                });
                return restfulResponse(res, 400, { success: false });
            }

            if (consumerImportRes) {
                await processLeftOperands(['count'], contractID, resourceID);
            }

            return restfulResponse(res, 200, { success: true });
        } else {
            return restfulResponse(res, 500, { success: false });
        }
    }
};
