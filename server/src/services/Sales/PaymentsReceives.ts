import { omit, sumBy, difference } from 'lodash';
import moment from 'moment';
import { Service, Inject } from 'typedi';
import {
  EventDispatcher,
  EventDispatcherInterface,
} from 'decorators/eventDispatcher';
import events from 'subscribers/events';
import {
  IAccount,
  IFilterMeta,
  IPaginationMeta,
  IPaymentReceive,
  IPaymentReceiveCreateDTO,
  IPaymentReceiveEditDTO,
  IPaymentReceiveEntry,
  IPaymentReceiveEntryDTO,
  IPaymentReceivesFilter,
  ISaleInvoice,
  ISystemUser,
} from 'interfaces';
import AccountsService from 'services/Accounts/AccountsService';
import JournalPoster from 'services/Accounting/JournalPoster';
import JournalEntry from 'services/Accounting/JournalEntry';
import JournalPosterService from 'services/Sales/JournalPosterService';
import TenancyService from 'services/Tenancy/TenancyService';
import DynamicListingService from 'services/DynamicListing/DynamicListService';
import { formatDateFields, entriesAmountDiff } from 'utils';
import { ServiceError } from 'exceptions';
import CustomersService from 'services/Contacts/CustomersService';
import ItemsEntriesService from 'services/Items/ItemsEntriesService';
import JournalCommands from 'services/Accounting/JournalCommands';

const ERRORS = {
  PAYMENT_RECEIVE_NO_EXISTS: 'PAYMENT_RECEIVE_NO_EXISTS',
  PAYMENT_RECEIVE_NOT_EXISTS: 'PAYMENT_RECEIVE_NOT_EXISTS',
  DEPOSIT_ACCOUNT_NOT_FOUND: 'DEPOSIT_ACCOUNT_NOT_FOUND',
  DEPOSIT_ACCOUNT_NOT_CURRENT_ASSET_TYPE:
    'DEPOSIT_ACCOUNT_NOT_CURRENT_ASSET_TYPE',
  INVALID_PAYMENT_AMOUNT: 'INVALID_PAYMENT_AMOUNT',
  INVOICES_IDS_NOT_FOUND: 'INVOICES_IDS_NOT_FOUND',
  ENTRIES_IDS_NOT_EXISTS: 'ENTRIES_IDS_NOT_EXISTS',
  INVOICES_NOT_DELIVERED_YET: 'INVOICES_NOT_DELIVERED_YET',
};
/**
 * Payment receive service.
 * @service
 */
@Service()
export default class PaymentReceiveService {
  @Inject()
  accountsService: AccountsService;

  @Inject()
  customersService: CustomersService;

  @Inject()
  itemsEntries: ItemsEntriesService;

  @Inject()
  tenancy: TenancyService;

  @Inject()
  journalService: JournalPosterService;

  @Inject()
  dynamicListService: DynamicListingService;

  @Inject('logger')
  logger: any;

  @EventDispatcher()
  eventDispatcher: EventDispatcherInterface;

  /**
   * Validates the payment receive number existance.
   * @param {number} tenantId -
   * @param {string} paymentReceiveNo -
   */
  async validatePaymentReceiveNoExistance(
    tenantId: number,
    paymentReceiveNo: string,
    notPaymentReceiveId?: number
  ): Promise<void> {
    const { PaymentReceive } = this.tenancy.models(tenantId);
    const paymentReceive = await PaymentReceive.query()
      .findOne('payment_receive_no', paymentReceiveNo)
      .onBuild((builder) => {
        if (notPaymentReceiveId) {
          builder.whereNot('id', notPaymentReceiveId);
        }
      });

    if (paymentReceive) {
      throw new ServiceError(ERRORS.PAYMENT_RECEIVE_NO_EXISTS);
    }
  }

  /**
   * Validates the payment receive existance.
   * @param {number} tenantId -
   * @param {number} paymentReceiveId -
   */
  async getPaymentReceiveOrThrowError(
    tenantId: number,
    paymentReceiveId: number
  ): Promise<IPaymentReceive> {
    const { PaymentReceive } = this.tenancy.models(tenantId);
    const paymentReceive = await PaymentReceive.query()
      .withGraphFetched('entries')
      .findById(paymentReceiveId);

    if (!paymentReceive) {
      throw new ServiceError(ERRORS.PAYMENT_RECEIVE_NOT_EXISTS);
    }
    return paymentReceive;
  }

  /**
   * Validate the deposit account id existance.
   * @param {number} tenantId -
   * @param {number} depositAccountId -
   */
  async getDepositAccountOrThrowError(
    tenantId: number,
    depositAccountId: number
  ): Promise<IAccount> {
    const {
      accountTypeRepository,
      accountRepository,
    } = this.tenancy.repositories(tenantId);

    const currentAssetTypes = await accountTypeRepository.getByChildType(
      'current_asset'
    );
    const depositAccount = await accountRepository.findOneById(
      depositAccountId
    );

    const currentAssetTypesIds = currentAssetTypes.map((type) => type.id);

    if (!depositAccount) {
      throw new ServiceError(ERRORS.DEPOSIT_ACCOUNT_NOT_FOUND);
    }
    if (currentAssetTypesIds.indexOf(depositAccount.accountTypeId) === -1) {
      throw new ServiceError(ERRORS.DEPOSIT_ACCOUNT_NOT_CURRENT_ASSET_TYPE);
    }
    return depositAccount;
  }

  /**
   * Validates the invoices IDs existance.
   * @param {number} tenantId -
   * @param {} paymentReceiveEntries -
   */
  async validateInvoicesIDsExistance(
    tenantId: number,
    customerId: number,
    paymentReceiveEntries: IPaymentReceiveEntryDTO[]
  ): Promise<void> {
    const { SaleInvoice } = this.tenancy.models(tenantId);

    const invoicesIds = paymentReceiveEntries.map(
      (e: IPaymentReceiveEntryDTO) => e.invoiceId
    );
    const storedInvoices = await SaleInvoice.query()
      .whereIn('id', invoicesIds)
      .where('customer_id', customerId);

    const storedInvoicesIds = storedInvoices.map((invoice) => invoice.id);
    const notFoundInvoicesIDs = difference(invoicesIds, storedInvoicesIds);

    if (notFoundInvoicesIDs.length > 0) {
      throw new ServiceError(ERRORS.INVOICES_IDS_NOT_FOUND);
    }
    // Filters the not delivered invoices.
    const notDeliveredInvoices = storedInvoices.filter(
      (invoice) => !invoice.isDelivered
    );

    if (notDeliveredInvoices.length > 0) {
      throw new ServiceError(ERRORS.INVOICES_NOT_DELIVERED_YET, null, {
        notDeliveredInvoices,
      });
    }
    return storedInvoices;
  }

  /**
   * Validates entries invoice payment amount.
   * @param {Request} req -
   * @param {Response} res -
   * @param {Function} next -
   */
  async validateInvoicesPaymentsAmount(
    tenantId: number,
    paymentReceiveEntries: IPaymentReceiveEntryDTO[],
    oldPaymentEntries: IPaymentReceiveEntry[] = []
  ) {
    const { SaleInvoice } = this.tenancy.models(tenantId);
    const invoicesIds = paymentReceiveEntries.map(
      (e: IPaymentReceiveEntryDTO) => e.invoiceId
    );

    const storedInvoices = await SaleInvoice.query().whereIn('id', invoicesIds);

    const storedInvoicesMap = new Map(
      storedInvoices.map((invoice: ISaleInvoice) => {
        const oldEntries = oldPaymentEntries.filter((entry) => entry.invoiceId);
        const oldPaymentAmount = sumBy(oldEntries, 'paymentAmount') || 0;

        return [
          invoice.id,
          { ...invoice, dueAmount: invoice.dueAmount + oldPaymentAmount },
        ];
      })
    );
    const hasWrongPaymentAmount: any[] = [];

    paymentReceiveEntries.forEach(
      (entry: IPaymentReceiveEntryDTO, index: number) => {
        const entryInvoice = storedInvoicesMap.get(entry.invoiceId);
        const { dueAmount } = entryInvoice;

        if (dueAmount < entry.paymentAmount) {
          hasWrongPaymentAmount.push({ index, due_amount: dueAmount });
        }
      }
    );
    if (hasWrongPaymentAmount.length > 0) {
      throw new ServiceError(ERRORS.INVALID_PAYMENT_AMOUNT);
    }
  }

  /**
   * Validate the payment receive entries IDs existance.
   * @param {number} tenantId
   * @param {number} paymentReceiveId
   * @param {IPaymentReceiveEntryDTO[]} paymentReceiveEntries
   */
  private async validateEntriesIdsExistance(
    tenantId: number,
    paymentReceiveId: number,
    paymentReceiveEntries: IPaymentReceiveEntryDTO[]
  ) {
    const { PaymentReceiveEntry } = this.tenancy.models(tenantId);

    const entriesIds = paymentReceiveEntries
      .filter((entry) => entry.id)
      .map((entry) => entry.id);

    const storedEntries = await PaymentReceiveEntry.query().where(
      'payment_receive_id',
      paymentReceiveId
    );

    const storedEntriesIds = storedEntries.map((entry: any) => entry.id);
    const notFoundEntriesIds = difference(entriesIds, storedEntriesIds);

    if (notFoundEntriesIds.length > 0) {
      throw new ServiceError(ERRORS.ENTRIES_IDS_NOT_EXISTS);
    }
  }

  /**
   * Creates a new payment receive and store it to the storage
   * with associated invoices payment and journal transactions.
   * @async
   * @param {number} tenantId - Tenant id.
   * @param {IPaymentReceive} paymentReceive
   */
  public async createPaymentReceive(
    tenantId: number,
    paymentReceiveDTO: IPaymentReceiveCreateDTO,
    authorizedUser: ISystemUser
  ) {
    const { PaymentReceive } = this.tenancy.models(tenantId);
    const paymentAmount = sumBy(paymentReceiveDTO.entries, 'paymentAmount');

    // Validate payment receive number uniquiness.
    if (paymentReceiveDTO.paymentReceiveNo) {
      await this.validatePaymentReceiveNoExistance(
        tenantId,
        paymentReceiveDTO.paymentReceiveNo
      );
    }
    // Validate customer existance.
    await this.customersService.getCustomerByIdOrThrowError(
      tenantId,
      paymentReceiveDTO.customerId
    );

    // Validate the deposit account existance and type.
    await this.getDepositAccountOrThrowError(
      tenantId,
      paymentReceiveDTO.depositAccountId
    );

    // Validate payment receive invoices IDs existance.
    await this.validateInvoicesIDsExistance(
      tenantId,
      paymentReceiveDTO.customerId,
      paymentReceiveDTO.entries
    );

    // Validate invoice payment amount.
    await this.validateInvoicesPaymentsAmount(
      tenantId,
      paymentReceiveDTO.entries
    );

    this.logger.info('[payment_receive] inserting to the storage.');
    const paymentReceive = await PaymentReceive.query().insertGraphAndFetch({
      amount: paymentAmount,
      ...formatDateFields(omit(paymentReceiveDTO, ['entries']), [
        'paymentDate',
      ]),

      entries: paymentReceiveDTO.entries.map((entry) => ({
        ...omit(entry, ['id']),
      })),
    });

    await this.eventDispatcher.dispatch(events.paymentReceive.onCreated, {
      tenantId,
      paymentReceive,
      paymentReceiveId: paymentReceive.id,
      authorizedUser,
    });
    this.logger.info('[payment_receive] updated successfully.', {
      tenantId,
      paymentReceive,
    });

    return paymentReceive;
  }

  /**
   * Edit details the given payment receive with associated entries.
   * ------
   * - Update the payment receive transactions.
   * - Insert the new payment receive entries.
   * - Update the given payment receive entries.
   * - Delete the not presented payment receive entries.
   * - Re-insert the journal transactions and update the different accounts balance.
   * - Update the different customer balances.
   * - Update the different invoice payment amount.
   * @async
   * @param {number} tenantId -
   * @param {Integer} paymentReceiveId -
   * @param {IPaymentReceive} paymentReceive -
   */
  public async editPaymentReceive(
    tenantId: number,
    paymentReceiveId: number,
    paymentReceiveDTO: IPaymentReceiveEditDTO,
    authorizedUser: ISystemUser
  ) {
    const { PaymentReceive } = this.tenancy.models(tenantId);
    const paymentAmount = sumBy(paymentReceiveDTO.entries, 'paymentAmount');

    this.logger.info('[payment_receive] trying to edit payment receive.', {
      tenantId,
      paymentReceiveId,
      paymentReceiveDTO,
    });

    // Validate the payment receive existance.
    const oldPaymentReceive = await this.getPaymentReceiveOrThrowError(
      tenantId,
      paymentReceiveId
    );

    // Validate payment receive number uniquiness.
    if (paymentReceiveDTO.paymentReceiveNo) {
      await this.validatePaymentReceiveNoExistance(
        tenantId,
        paymentReceiveDTO.paymentReceiveNo,
        paymentReceiveId
      );
    }
    // Validate the deposit account existance and type.
    this.getDepositAccountOrThrowError(
      tenantId,
      paymentReceiveDTO.depositAccountId
    );

    // Validate the entries ids existance on payment receive type.
    await this.validateEntriesIdsExistance(
      tenantId,
      paymentReceiveId,
      paymentReceiveDTO.entries
    );

    // Validate payment receive invoices IDs existance and associated to the given customer id.
    await this.validateInvoicesIDsExistance(
      tenantId,
      oldPaymentReceive.customerId,
      paymentReceiveDTO.entries
    );

    // Validate invoice payment amount.
    await this.validateInvoicesPaymentsAmount(
      tenantId,
      paymentReceiveDTO.entries,
      oldPaymentReceive.entries
    );

    // Update the payment receive transaction.
    const paymentReceive = await PaymentReceive.query().upsertGraphAndFetch({
      id: paymentReceiveId,
      amount: paymentAmount,
      ...formatDateFields(omit(paymentReceiveDTO, ['entries']), [
        'paymentDate',
      ]),
      entries: paymentReceiveDTO.entries,
    });

    await this.eventDispatcher.dispatch(events.paymentReceive.onEdited, {
      tenantId,
      paymentReceiveId,
      paymentReceive,
      oldPaymentReceive,
      authorizedUser,
    });
    this.logger.info('[payment_receive] upserted successfully.', {
      tenantId,
      paymentReceiveId,
    });
  }

  /**
   * Deletes the given payment receive with associated entries
   * and journal transactions.
   * -----
   * - Deletes the payment receive transaction.
   * - Deletes the payment receive associated entries.
   * - Deletes the payment receive associated journal transactions.
   * - Revert the customer balance.
   * - Revert the payment amount of the associated invoices.
   * @async
   * @param {number} tenantId - Tenant id.
   * @param {Integer} paymentReceiveId - Payment receive id.
   * @param {IPaymentReceive} paymentReceive - Payment receive object.
   */
  async deletePaymentReceive(
    tenantId: number,
    paymentReceiveId: number,
    authorizedUser: ISystemUser
  ) {
    const { PaymentReceive, PaymentReceiveEntry } = this.tenancy.models(
      tenantId
    );

    const oldPaymentReceive = await this.getPaymentReceiveOrThrowError(
      tenantId,
      paymentReceiveId
    );

    // Deletes the payment receive associated entries.
    await PaymentReceiveEntry.query()
      .where('payment_receive_id', paymentReceiveId)
      .delete();

    // Deletes the payment receive transaction.
    await PaymentReceive.query().findById(paymentReceiveId).delete();

    await this.eventDispatcher.dispatch(events.paymentReceive.onDeleted, {
      tenantId,
      paymentReceiveId,
      oldPaymentReceive,
      authorizedUser,
    });
    this.logger.info('[payment_receive] deleted successfully.', {
      tenantId,
      paymentReceiveId,
    });
  }

  /**
   * Retrieve the payment receive details of the given id.
   * @param {number} tenantId - Tenant id.
   * @param {Integer} paymentReceiveId - Payment receive id.
   */
  public async getPaymentReceive(
    tenantId: number,
    paymentReceiveId: number,
  ): Promise<{
    paymentReceive: IPaymentReceive;
    receivableInvoices: ISaleInvoice[];
    paymentReceiveInvoices: ISaleInvoice[];
  }> {
    const { PaymentReceive, SaleInvoice } = this.tenancy.models(tenantId);
    const paymentReceive = await PaymentReceive.query()
      .findById(paymentReceiveId)
      .withGraphFetched('entries.invoice')
      .withGraphFetched('customer')
      .withGraphFetched('depositAccount');

    if (!paymentReceive) {
      throw new ServiceError(ERRORS.PAYMENT_RECEIVE_NOT_EXISTS);
    }
    const invoicesIds = paymentReceive.entries.map((entry) => entry.invoiceId);

    // Retrieves all receivable bills that associated to the payment receive transaction.
    const receivableInvoices = await SaleInvoice.query()
      .modify('dueInvoices')
      .where('customer_id', paymentReceive.customerId)
      .whereNotIn('id', invoicesIds)
      .orderBy('invoice_date', 'ASC');

    // Retrieve all payment receive associated invoices.
    const paymentReceiveInvoices = paymentReceive.entries.map((entry) => ({
      ...entry.invoice,
      dueAmount: entry.invoice.dueAmount + entry.paymentAmount,
    }));

    return { paymentReceive, receivableInvoices, paymentReceiveInvoices };
  }

  /**
   * Retrieve sale invoices that assocaited to the given payment receive.
   * @param {number} tenantId - Tenant id.
   * @param {number} paymentReceiveId - Payment receive id.
   * @return {Promise<ISaleInvoice>}
   */
  public async getPaymentReceiveInvoices(
    tenantId: number,
    paymentReceiveId: number
  ) {
    const { SaleInvoice } = this.tenancy.models(tenantId);

    const paymentReceive = await this.getPaymentReceiveOrThrowError(
      tenantId,
      paymentReceiveId
    );
    const paymentReceiveInvoicesIds = paymentReceive.entries.map(
      (entry) => entry.invoiceId
    );

    const saleInvoices = await SaleInvoice.query().whereIn(
      'id',
      paymentReceiveInvoicesIds
    );

    return saleInvoices;
  }

  /**
   * Retrieve payment receives paginated and filterable list.
   * @param {number} tenantId
   * @param {IPaymentReceivesFilter} paymentReceivesFilter
   */
  public async listPaymentReceives(
    tenantId: number,
    paymentReceivesFilter: IPaymentReceivesFilter
  ): Promise<{
    paymentReceives: IPaymentReceive[];
    pagination: IPaginationMeta;
    filterMeta: IFilterMeta;
  }> {
    const { PaymentReceive } = this.tenancy.models(tenantId);
    const dynamicFilter = await this.dynamicListService.dynamicList(
      tenantId,
      PaymentReceive,
      paymentReceivesFilter
    );

    const { results, pagination } = await PaymentReceive.query()
      .onBuild((builder) => {
        builder.withGraphFetched('customer');
        builder.withGraphFetched('depositAccount');
        dynamicFilter.buildQuery()(builder);
      })
      .pagination(
        paymentReceivesFilter.page - 1,
        paymentReceivesFilter.pageSize
      );
    return {
      paymentReceives: results,
      pagination,
      filterMeta: dynamicFilter.getResponseMeta(),
    };
  }

  /**
   * Retrieve the payment receive details with associated invoices.
   * @param {Integer} paymentReceiveId
   */
  async getPaymentReceiveWithInvoices(
    tenantId: number,
    paymentReceiveId: number
  ) {
    const { PaymentReceive } = this.tenancy.models(tenantId);
    return PaymentReceive.query()
      .where('id', paymentReceiveId)
      .withGraphFetched('invoices')
      .first();
  }

  /**
   * Records payment receive journal transactions.
   *
   * Invoice payment journals.
   * --------
   * - Account receivable -> Debit
   * - Payment account [current asset] -> Credit
   */
  public async recordPaymentReceiveJournalEntries(
    tenantId: number,
    paymentReceive: IPaymentReceive,
    authorizedUserId: number,
    override: boolean = false
  ): Promise<void> {
    const {
      accountRepository,
      transactionsRepository,
    } = this.tenancy.repositories(tenantId);

    const paymentAmount = sumBy(paymentReceive.entries, 'paymentAmount');

    // Retrieve the receivable account.
    const receivableAccount = await accountRepository.findOne({
      slug: 'accounts-receivable',
    });
    // Accounts dependency graph.
    const accountsDepGraph = await accountRepository.getDependencyGraph();

    const journal = new JournalPoster(tenantId, accountsDepGraph);
    const commonJournal = {
      debit: 0,
      credit: 0,
      referenceId: paymentReceive.id,
      referenceType: 'PaymentReceive',
      date: paymentReceive.paymentDate,
      userId: authorizedUserId,
    };
    if (override) {
      const transactions = await transactionsRepository.journal({
        referenceType: ['PaymentReceive'],
        referenceId: [paymentReceive.id],
      });
      journal.fromTransactions(transactions);
      journal.removeEntries();
    }
    const creditReceivable = new JournalEntry({
      ...commonJournal,
      credit: paymentAmount,
      contactType: 'Customer',
      contactId: paymentReceive.customerId,
      account: receivableAccount.id,
      index: 1,
    });
    const debitDepositAccount = new JournalEntry({
      ...commonJournal,
      debit: paymentAmount,
      account: paymentReceive.depositAccountId,
      index: 2,
    });
    journal.credit(creditReceivable);
    journal.debit(debitDepositAccount);

    await Promise.all([
      journal.deleteEntries(),
      journal.saveEntries(),
      journal.saveBalance(),
    ]);
  }

  /**
   * Reverts the given payment receive journal entries.
   * @param {number} tenantId 
   * @param {number} paymentReceiveId 
   */
  async revertPaymentReceiveJournalEntries(
    tenantId: number,
    paymentReceiveId: number,
  ) {
    const { accountRepository } = this.tenancy.repositories(tenantId);

    // Accounts dependency graph.
    const accountsDepGraph = await accountRepository.getDependencyGraph();

    const journal = new JournalPoster(tenantId, accountsDepGraph);
    const commands = new JournalCommands(journal);

    await commands.revertJournalEntries(paymentReceiveId, 'PaymentReceive');

    await Promise.all([journal.saveBalance(), journal.deleteEntries()]);
  }

  /**
   * Saves difference changing between old and new invoice payment amount.
   * @async
   * @param {number} tenantId - Tenant id.
   * @param {Array} paymentReceiveEntries
   * @param {Array} newPaymentReceiveEntries
   * @return {Promise<void>}
   */
  public async saveChangeInvoicePaymentAmount(
    tenantId: number,
    newPaymentReceiveEntries: IPaymentReceiveEntryDTO[],
    oldPaymentReceiveEntries?: IPaymentReceiveEntryDTO[]
  ): Promise<void> {
    const { SaleInvoice } = this.tenancy.models(tenantId);
    const opers: Promise<void>[] = [];

    const diffEntries = entriesAmountDiff(
      newPaymentReceiveEntries,
      oldPaymentReceiveEntries,
      'paymentAmount',
      'invoiceId'
    );
    diffEntries.forEach((diffEntry: any) => {
      if (diffEntry.paymentAmount === 0) {
        return;
      }

      const oper = SaleInvoice.changePaymentAmount(
        diffEntry.invoiceId,
        diffEntry.paymentAmount
      );
      opers.push(oper);
    });
    await Promise.all([...opers]);
  }
}
